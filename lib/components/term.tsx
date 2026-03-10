import {clipboard, shell} from 'electron';
import React from 'react';

import Color from 'color';
import isEqual from 'lodash/isEqual';
import pickBy from 'lodash/pickBy';
import {Terminal} from 'xterm';
import type {ITerminalOptions, IDisposable} from 'xterm';
import {CanvasAddon} from 'xterm-addon-canvas';
import {FitAddon} from 'xterm-addon-fit';
import {ImageAddon} from 'xterm-addon-image';
import {LigaturesAddon} from 'xterm-addon-ligatures';
import {SearchAddon} from 'xterm-addon-search';
import type {ISearchDecorationOptions} from 'xterm-addon-search';
import {Unicode11Addon} from 'xterm-addon-unicode11';
import {WebLinksAddon} from 'xterm-addon-web-links';
import {WebglAddon} from 'xterm-addon-webgl';

import type {TermProps} from '../../typings/hyper';
import terms from '../terms';
import processClipboard from '../utils/paste';
import {decorate} from '../utils/plugins';

import _SearchBox from './searchBox';

import 'xterm/css/xterm.css';

const SearchBox = decorate(_SearchBox, 'SearchBox');

const isWindows = ['Windows', 'Win16', 'Win32', 'WinCE'].includes(navigator.platform) || process.platform === 'win32';

// Describe the subset of xterm's internal render service used to calculate smooth-scroll offsets.
type SmoothScrollRenderService = {
  dimensions: {
    css: {
      cell: {
        height: number;
      };
    };
  };
  onDimensionsChange: (listener: () => void) => IDisposable;
};

// map old hterm constants to xterm.js
const CURSOR_STYLES = {
  BEAM: 'bar',
  UNDERLINE: 'underline',
  BLOCK: 'block'
} as const;

const isWebgl2Supported = (() => {
  let isSupported = window.WebGL2RenderingContext ? undefined : false;
  return () => {
    if (isSupported === undefined) {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2', {depth: false, antialias: false});
      isSupported = gl instanceof window.WebGL2RenderingContext;
    }
    return isSupported;
  };
})();

const getTermOptions = (props: TermProps): ITerminalOptions => {
  // Set a background color only if it is opaque
  const needTransparency = Color(props.backgroundColor).alpha() < 1;
  const backgroundColor = needTransparency ? 'rgba(0,0,0,0)' : props.backgroundColor;

  return {
    macOptionIsMeta: props.modifierKeys.altIsMeta,
    scrollback: props.scrollback,
    cursorStyle: CURSOR_STYLES[props.cursorShape],
    cursorBlink: props.cursorBlink,
    fontFamily: props.fontFamily,
    fontSize: props.fontSize,
    fontWeight: props.fontWeight,
    fontWeightBold: props.fontWeightBold,
    lineHeight: props.lineHeight,
    letterSpacing: props.letterSpacing,
    allowTransparency: needTransparency,
    macOptionClickForcesSelection: props.macOptionSelectionMode === 'force',
    windowsMode: isWindows,
    ...(isWindows && props.windowsPty && {windowsPty: props.windowsPty}),
    theme: {
      foreground: props.foregroundColor,
      background: backgroundColor,
      cursor: props.cursorColor,
      cursorAccent: props.cursorAccentColor,
      selectionBackground: props.selectionColor,
      black: props.colors.black,
      red: props.colors.red,
      green: props.colors.green,
      yellow: props.colors.yellow,
      blue: props.colors.blue,
      magenta: props.colors.magenta,
      cyan: props.colors.cyan,
      white: props.colors.white,
      brightBlack: props.colors.lightBlack,
      brightRed: props.colors.lightRed,
      brightGreen: props.colors.lightGreen,
      brightYellow: props.colors.lightYellow,
      brightBlue: props.colors.lightBlue,
      brightMagenta: props.colors.lightMagenta,
      brightCyan: props.colors.lightCyan,
      brightWhite: props.colors.lightWhite
    },
    screenReaderMode: props.screenReaderMode,
    overviewRulerWidth: 20,
    allowProposedApi: true
  };
};

export default class Term extends React.PureComponent<
  TermProps,
  {
    searchOptions: {
      caseSensitive: boolean;
      wholeWord: boolean;
      regex: boolean;
    };
    searchResults:
      | {
          resultIndex: number;
          resultCount: number;
        }
      | undefined;
  }
> {
  termRef: HTMLElement | null;
  termWrapperRef: HTMLElement | null;
  termOptions: ITerminalOptions;
  disposableListeners: IDisposable[];
  defaultBellSound: HTMLAudioElement | null;
  bellSound: HTMLAudioElement | null;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  static rendererTypes: Record<string, string>;
  term!: Terminal;
  resizeObserver!: ResizeObserver;
  resizeTimeout!: NodeJS.Timeout;
  searchDecorations: ISearchDecorationOptions;
  // Keep the active scroll listener for the normal buffer.
  smoothScrollHandler: (() => void) | null;
  // Keep the alternate-buffer listener that simply clears any active transform.
  smoothScrollAlternateHandler: (() => void) | null;
  // Track whichever scroll listener is currently attached to the viewport.
  smoothScrollViewportHandler: (() => void) | null;
  // Cache the rendered cell height so sub-line offsets can be computed from scrollTop.
  smoothScrollCellHeight: number | null;
  // Cache the xterm viewport element used for scroll events.
  smoothScrollViewport: HTMLElement | null;
  // Cache the xterm screen element that receives the translateY transform.
  smoothScrollScreen: HTMLElement | null;
  state = {
    searchOptions: {
      caseSensitive: false,
      wholeWord: false,
      regex: false
    },
    searchResults: undefined
  };

  constructor(props: TermProps) {
    super(props);
    props.ref_(props.uid, this);
    this.termRef = null;
    this.termWrapperRef = null;
    this.termOptions = {};
    this.disposableListeners = [];
    this.defaultBellSound = null;
    this.bellSound = null;
    // Initialize the smooth-scroll state before the terminal DOM is mounted.
    this.smoothScrollHandler = null;
    this.smoothScrollAlternateHandler = null;
    this.smoothScrollViewportHandler = null;
    this.smoothScrollCellHeight = null;
    this.smoothScrollViewport = null;
    this.smoothScrollScreen = null;
    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.searchDecorations = {
      activeMatchColorOverviewRuler: Color(this.props.cursorColor).hex(),
      matchOverviewRuler: Color(this.props.borderColor).hex(),
      activeMatchBackground: Color(this.props.cursorColor).hex(),
      activeMatchBorder: Color(this.props.cursorColor).hex(),
      matchBorder: Color(this.props.cursorColor).hex()
    };
  }

  // The main process shows this in the About dialog
  static reportRenderer(uid: string, type: string) {
    const rendererTypes = Term.rendererTypes || {};
    if (rendererTypes[uid] !== type) {
      rendererTypes[uid] = type;
      Term.rendererTypes = rendererTypes;
      window.rpc.emit('info renderer', {uid, type});
    }
  }

  componentDidMount() {
    const {props} = this;

    this.termOptions = getTermOptions(props);
    this.term = props.term || new Terminal(this.termOptions);
    this.defaultBellSound = new Audio(
      // Source: https://freesound.org/people/altemark/sounds/45759/
      // This sound is released under the Creative Commons Attribution 3.0 Unported
      // (CC BY 3.0) license. It was created by 'altemark'. No modifications have been
      // made, apart from the conversion to base64.
      'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjMyLjEwNAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
    );
    this.setBellSound(props.bell, props.bellSound);

    // The parent element for the terminal is attached and removed manually so
    // that we can preserve it across mounts and unmounts of the component
    this.termRef = props.term ? props.term.element!.parentElement! : document.createElement('div');
    this.termRef.className = 'term_fit term_term';

    this.termWrapperRef?.appendChild(this.termRef);

    if (!props.term) {
      const needTransparency = Color(props.backgroundColor).alpha() < 1;
      let useWebGL = false;
      if (props.webGLRenderer) {
        if (needTransparency) {
          console.warn(
            'WebGL Renderer has been disabled since it does not support transparent backgrounds yet. ' +
              'Falling back to canvas-based rendering.'
          );
        } else if (!isWebgl2Supported()) {
          console.warn('WebGL2 is not supported on your machine. Falling back to canvas-based rendering.');
        } else {
          // Experimental WebGL renderer needs some more glue-code to make it work on Hyper.
          // If you're working on enabling back WebGL, you will also need to look into `xterm-addon-ligatures` support for that renderer.
          useWebGL = true;
        }
      }
      Term.reportRenderer(props.uid, useWebGL ? 'WebGL' : 'Canvas');

      const shallActivateWebLink = (event: MouseEvent): boolean => {
        if (!event) return false;
        return props.webLinksActivationKey ? event[`${props.webLinksActivationKey}Key`] : true;
      };

      // eslint-disable-next-line @typescript-eslint/unbound-method
      this.term.attachCustomKeyEventHandler(this.keyboardHandler);
      this.term.loadAddon(this.fitAddon);
      this.term.loadAddon(this.searchAddon);
      this.term.loadAddon(
        new WebLinksAddon((event, uri) => {
          if (shallActivateWebLink(event)) void shell.openExternal(uri);
        })
      );
      this.term.open(this.termRef);

      if (useWebGL) {
        const webglAddon = new WebglAddon();
        this.term.loadAddon(webglAddon);
        webglAddon.onContextLoss(() => {
          console.warn('WebGL context lost. Falling back to canvas-based rendering.');
          webglAddon.dispose();
          this.term.loadAddon(new CanvasAddon());
        });
      } else {
        this.term.loadAddon(new CanvasAddon());
      }

      if (props.disableLigatures !== true && !useWebGL) {
        this.term.loadAddon(new LigaturesAddon());
      }

      this.term.loadAddon(new Unicode11Addon());
      this.term.unicode.activeVersion = '11';

      if (props.imageSupport) {
        this.term.loadAddon(new ImageAddon());
      }
    } else {
      // get the cached plugins
      this.fitAddon = props.fitAddon!;
      this.searchAddon = props.searchAddon!;
    }

    try {
      this.term.element!.style.padding = props.padding;
    } catch (error) {
      console.log(error);
    }

    this.fitAddon.fit();
    // Wire the DOM-based smooth-scroll transform after xterm has been opened and sized.
    this.setupSmoothScroll();

    if (this.props.isTermActive) {
      this.term.focus();
    }

    if (props.onTitle) {
      this.disposableListeners.push(this.term.onTitleChange(props.onTitle));
    }

    if (props.onActive) {
      this.term.textarea?.addEventListener('focus', props.onActive);
      this.disposableListeners.push({
        dispose: () => this.term.textarea?.removeEventListener('focus', this.props.onActive)
      });
    }

    if (props.onData) {
      this.disposableListeners.push(this.term.onData(props.onData));
    }

    this.term.onBell(() => {
      this.ringBell();
    });

    if (props.onResize) {
      this.disposableListeners.push(
        this.term.onResize(({cols, rows}) => {
          props.onResize(cols, rows);
        })
      );

      // the row and col of init session is null, so reize the node-pty
      props.onResize(this.term.cols, this.term.rows);
    }

    if (props.onCursorMove) {
      this.disposableListeners.push(
        this.term.onCursorMove(() => {
          const cursorFrame = {
            x: this.term.buffer.active.cursorX * (this.term as any)._core._renderService.dimensions.actualCellWidth,
            y: this.term.buffer.active.cursorY * (this.term as any)._core._renderService.dimensions.actualCellHeight,
            width: (this.term as any)._core._renderService.dimensions.actualCellWidth,
            height: (this.term as any)._core._renderService.dimensions.actualCellHeight,
            col: this.term.buffer.active.cursorX,
            row: this.term.buffer.active.cursorY
          };
          props.onCursorMove?.(cursorFrame);
        })
      );
    }

    this.disposableListeners.push(
      this.searchAddon.onDidChangeResults((results) => {
        this.setState((state) => ({
          ...state,
          searchResults: results
        }));
      })
    );

    window.addEventListener('paste', this.onWindowPaste, {
      capture: true
    });

    terms[this.props.uid] = this;
  }

  getTermDocument() {
    console.warn(
      'The underlying terminal engine of Hyper no longer ' +
        'uses iframes with individual `document` objects for each ' +
        'terminal instance. This method call is retained for ' +
        "backwards compatibility reasons. It's ok to attach directly" +
        'to the `document` object of the main `window`.'
    );
    return document;
  }

  // intercepting paste event for any necessary processing of
  // clipboard data, if result is falsy, paste event continues
  onWindowPaste = (e: Event) => {
    if (!this.props.isTermActive) return;

    const processed = processClipboard();
    if (processed) {
      e.preventDefault();
      e.stopPropagation();
      this.term.paste(processed);
    }
  };

  onMouseUp = (e: React.MouseEvent) => {
    if (this.props.quickEdit && e.button === 2) {
      if (this.term.hasSelection()) {
        clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
      } else {
        document.execCommand('paste');
      }
    } else if (this.props.copyOnSelect && this.term.hasSelection()) {
      clipboard.writeText(this.term.getSelection());
    }
  };

  write(data: string | Uint8Array) {
    this.term.write(data);
  }

  focus = () => {
    this.term.focus();
  };

  clear() {
    this.term.clear();
  }

  reset() {
    this.term.reset();
  }

  searchNext = (searchTerm: string) => {
    this.searchAddon.findNext(searchTerm, {
      ...this.state.searchOptions,
      decorations: this.searchDecorations
    });
  };

  searchPrevious = (searchTerm: string) => {
    this.searchAddon.findPrevious(searchTerm, {
      ...this.state.searchOptions,
      decorations: this.searchDecorations
    });
  };

  closeSearchBox = () => {
    this.props.onCloseSearch();
    this.searchAddon.clearDecorations();
    this.searchAddon.clearActiveDecoration();
    this.setState((state) => ({
      ...state,
      searchResults: undefined
    }));
    this.term.focus();
  };

  resize(cols: number, rows: number) {
    this.term.resize(cols, rows);
  }

  selectAll() {
    this.term.selectAll();
  }

  fitResize() {
    if (!this.termWrapperRef) {
      return;
    }
    this.fitAddon.fit();
  }

  getSmoothScrollRenderService(): SmoothScrollRenderService | undefined {
    // Reach into xterm internals to access the render metrics used by the smooth-scroll logic.
    return (this.term as any)._core?._renderService as SmoothScrollRenderService | undefined;
  }

  updateSmoothScrollCellHeight() {
    // Read the current rendered cell height so scroll offsets stay aligned with xterm's layout.
    const cellHeight = this.getSmoothScrollRenderService()?.dimensions.css.cell.height;
    // Cache the latest cell height, or clear it when the render service cannot provide one.
    this.smoothScrollCellHeight = cellHeight || null;

    if (!this.smoothScrollCellHeight) {
      // Reset any previous transform when a valid cell height is unavailable.
      this.clearSmoothScrollTransform();
      return;
    }

    // Re-run the active scroll handler so the transform uses the latest measurements.
    this.smoothScrollViewportHandler?.();
  }

  clearSmoothScrollTransform() {
    if (this.smoothScrollScreen) {
      // Remove the translateY adjustment so the screen snaps back to xterm's base position.
      this.smoothScrollScreen.style.transform = '';
    }
  }

  setSmoothScrollViewportHandler(handler: (() => void) | null) {
    if (!this.smoothScrollViewport) {
      return;
    }

    if (this.smoothScrollViewportHandler) {
      // Detach the previous scroll listener before swapping handlers.
      this.smoothScrollViewport.removeEventListener('scroll', this.smoothScrollViewportHandler);
    }

    if (handler) {
      // Attach the new scroll listener for the currently active buffer mode.
      this.smoothScrollViewport.addEventListener('scroll', handler);
    }

    // Remember which handler is currently bound so it can be updated or removed later.
    this.smoothScrollViewportHandler = handler;
  }

  updateSmoothScrollViewportHandler() {
    if (this.term.buffer.active.type === 'alternate') {
      // Disable the smooth-scroll transform in the alternate buffer to avoid offsetting full-screen apps.
      this.clearSmoothScrollTransform();
      this.setSmoothScrollViewportHandler(this.smoothScrollAlternateHandler);
      return;
    }

    // Use the normal smooth-scroll handler for the primary scrollback buffer.
    this.setSmoothScrollViewportHandler(this.smoothScrollHandler);
    // Immediately sync the transform with the viewport's current scroll position.
    this.smoothScrollViewportHandler?.();
  }

  setupSmoothScroll() {
    // Locate the xterm viewport and screen nodes needed to observe scrolling and apply transforms.
    const viewport = this.termRef?.querySelector('.xterm-viewport') as HTMLElement;
    const screen = this.termRef?.querySelector('.xterm-screen') as HTMLElement;
    // Read xterm's render service so the transform can stay aligned with rendered cell metrics.
    const renderService = this.getSmoothScrollRenderService();
    // Abort setup when any required DOM node or render metric source is unavailable.
    if (!viewport || !screen || !renderService) return;

    // Cache the viewport node for listener management and cleanup.
    this.smoothScrollViewport = viewport;
    // Cache the screen node because that is the element translated during smooth scrolling.
    this.smoothScrollScreen = screen;

    // Promote to compositing layer for GPU-accelerated transforms
    screen.style.willChange = 'transform';

    this.smoothScrollHandler = () => {
      // if (!this.smoothScrollCellHeight) {
      //   this.clearSmoothScrollTransform();
      //   return;
      // }

      // Read the viewport scroll position that xterm has already applied.
      const scrollTop = viewport.scrollTop;
      // Match xterm.js's Math.round rounding to calculate the correct sub-line offset
      const renderedRow = Math.round(scrollTop / (this.smoothScrollCellHeight as number));
      // Compute the remaining fractional offset that should be smoothed with a transform.
      const offset = scrollTop - renderedRow * (this.smoothScrollCellHeight as number);
      // Translate the screen by the inverse fractional offset to smooth the row transition.
      screen.style.transform = `translateY(${-offset}px)`;
    };
    this.smoothScrollAlternateHandler = () => {
      // Keep alternate-buffer content anchored to xterm's native positioning.
      this.clearSmoothScrollTransform();
    };

    // Prime the cached cell height before any scroll events are processed.
    this.updateSmoothScrollCellHeight();
    this.disposableListeners.push(
      renderService.onDimensionsChange(() => {
        // Recalculate the cached cell height whenever xterm's render metrics change.
        this.updateSmoothScrollCellHeight();
      })
    );
    this.disposableListeners.push(
      this.term.buffer.onBufferChange(() => {
        // Swap scroll handlers when xterm switches between the normal and alternate buffers.
        this.updateSmoothScrollViewportHandler();
      })
    );
    // Attach the correct initial scroll listener for the buffer that is active right now.
    this.updateSmoothScrollViewportHandler();
  }

  keyboardHandler(e: any) {
    // Has Mousetrap flagged this event as a command?
    return !e.catched;
  }

  setBellSound(bell: 'SOUND' | false, sound: string | null) {
    if (bell && bell.toUpperCase() === 'SOUND') {
      this.bellSound = sound ? new Audio(sound) : this.defaultBellSound;
    } else {
      this.bellSound = null;
    }
  }

  ringBell() {
    void this.bellSound?.play();
  }

  componentDidUpdate(prevProps: TermProps) {
    if (!prevProps.cleared && this.props.cleared) {
      this.clear();
    }

    const nextTermOptions = getTermOptions(this.props);

    if (prevProps.bell !== this.props.bell || prevProps.bellSound !== this.props.bellSound) {
      this.setBellSound(this.props.bell, this.props.bellSound);
    }

    if (prevProps.search && !this.props.search) {
      this.closeSearchBox();
    }

    // Update only options that have changed.
    this.term.options = pickBy(
      nextTermOptions,
      (value, key) => !isEqual(this.termOptions[key as keyof ITerminalOptions], value)
    );

    this.termOptions = nextTermOptions;

    try {
      this.term.element!.style.padding = this.props.padding;
    } catch (error) {
      console.log(error);
    }

    if (
      this.props.fontSize !== prevProps.fontSize ||
      this.props.fontFamily !== prevProps.fontFamily ||
      this.props.lineHeight !== prevProps.lineHeight ||
      this.props.letterSpacing !== prevProps.letterSpacing
    ) {
      // resize to fit the container
      this.fitResize();
    }

    if (prevProps.rows !== this.props.rows || prevProps.cols !== this.props.cols) {
      this.resize(this.props.cols!, this.props.rows!);
    }
  }

  onTermWrapperRef = (component: HTMLElement | null) => {
    this.termWrapperRef = component;

    if (component) {
      this.resizeObserver = new ResizeObserver(() => {
        clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => {
          this.fitResize();
        }, 500);
      });
      this.resizeObserver.observe(component);
    } else {
      this.resizeObserver.disconnect();
    }
  };

  componentWillUnmount() {
    terms[this.props.uid] = null;
    this.termWrapperRef?.removeChild(this.termRef!);
    this.props.ref_(this.props.uid, null);

    // to clean up the terminal, we remove the listeners
    // instead of invoking `destroy`, since it will make the
    // term insta un-attachable in the future (which we need
    // to do in case of splitting, see `componentDidMount`
    this.disposableListeners.forEach((handler) => handler.dispose());
    this.disposableListeners = [];

    if (this.smoothScrollViewportHandler && this.smoothScrollViewport) {
      // Remove the viewport listener so the detached terminal no longer receives scroll callbacks.
      this.smoothScrollViewport.removeEventListener('scroll', this.smoothScrollViewportHandler);
    }
    // Clear any remaining transform before releasing the screen node reference.
    this.smoothScrollScreen?.style.removeProperty('transform');
    // Remove the compositing hint that was added during smooth-scroll setup.
    this.smoothScrollScreen?.style.removeProperty('will-change');
    // Drop all smooth-scroll callbacks so unmounted instances cannot be reused accidentally.
    this.smoothScrollHandler = null;
    this.smoothScrollAlternateHandler = null;
    this.smoothScrollViewportHandler = null;
    // Clear the cached measurements and DOM nodes associated with smooth scrolling.
    this.smoothScrollCellHeight = null;
    this.smoothScrollViewport = null;
    this.smoothScrollScreen = null;

    window.removeEventListener('paste', this.onWindowPaste, {
      capture: true
    });
  }

  render() {
    return (
      <div className={`term_fit ${this.props.isTermActive ? 'term_active' : ''}`} onMouseUp={this.onMouseUp}>
        {this.props.customChildrenBefore}
        <div ref={this.onTermWrapperRef} className="term_fit term_wrapper" />
        {this.props.customChildren}
        {this.props.search ? (
          <SearchBox
            next={this.searchNext}
            prev={this.searchPrevious}
            close={this.closeSearchBox}
            caseSensitive={this.state.searchOptions.caseSensitive}
            wholeWord={this.state.searchOptions.wholeWord}
            regex={this.state.searchOptions.regex}
            results={this.state.searchResults}
            toggleCaseSensitive={() =>
              this.setState({
                ...this.state,
                searchOptions: {...this.state.searchOptions, caseSensitive: !this.state.searchOptions.caseSensitive}
              })
            }
            toggleWholeWord={() =>
              this.setState({
                ...this.state,
                searchOptions: {...this.state.searchOptions, wholeWord: !this.state.searchOptions.wholeWord}
              })
            }
            toggleRegex={() =>
              this.setState({
                ...this.state,
                searchOptions: {...this.state.searchOptions, regex: !this.state.searchOptions.regex}
              })
            }
            selectionColor={this.props.selectionColor}
            backgroundColor={this.props.backgroundColor}
            foregroundColor={this.props.foregroundColor}
            borderColor={this.props.borderColor}
            font={this.props.uiFontFamily}
          />
        ) : null}

        <style jsx global>{`
          .term_fit {
            display: block;
            width: 100%;
            height: 100%;
          }

          .term_wrapper {
            /* TODO: decide whether to keep this or not based on understanding what xterm-selection is for */
            overflow: hidden;
          }
        `}</style>
      </div>
    );
  }
}
