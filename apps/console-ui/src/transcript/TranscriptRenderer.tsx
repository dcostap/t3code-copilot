import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import type { OrchestrationThread, ThreadId } from "@t3tools/contracts";

import { AnimatedLoadingText } from "../AnimatedLoadingText";
import type { ComposerImageAttachment } from "../composerAttachments";
import { TranscriptHistory } from "./TranscriptHistory";

interface TranscriptRendererProps {
  readonly composerAttachments?: ReadonlyArray<ComposerImageAttachment>;
  readonly cwd?: string | null;
  readonly draftValue?: string;
  readonly getTurnDiff?: (input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  }) => Promise<string>;
  readonly thread?: OrchestrationThread | null;
  readonly projectRoot?: string | null;
  readonly paneActive?: boolean;
  readonly interactionMode?: "default" | "plan";
  readonly initialScrollOffsetFromBottom?: number | null;
  readonly loading?: boolean;
  readonly loadingLabel?: string | null;
  readonly promptFocusDisabled?: boolean;
  readonly promptInputDisabled?: boolean;
  readonly submitDisabled?: boolean;
  onAddImageFiles?(files: ReadonlyArray<File>): void;
  onDraftChange?(value: string): void;
  onRemoveImage?(attachmentId: string): void;
  onScrollOffsetFromBottomChange?(offsetFromBottom: number): void;
  onThreadRenderReady?(threadId: ThreadId): void;
  onSubmit?(value: string): Promise<void> | void;
}

export interface TranscriptRendererHandle {
  focus(): void;
  focusPrompt(options?: { readonly reveal?: boolean }): void;
  focusHistory(): void;
  hasFocusWithinPane(): boolean;
  openSearch(): void;
  isHistoryActive(): boolean;
  hasHistorySelection(): boolean;
  selectAllHistory(): boolean;
  insertPromptText(text: string): void;
  deletePromptBackward(): void;
  deletePromptForward(): void;
  submitPrompt(): void;
  scrollToBottom(): void;
}

interface TranscriptPromptHandle {
  focusPrompt(): void;
  insertPromptText(text: string): void;
  deletePromptBackward(): void;
  deletePromptForward(): void;
  submitPrompt(): void;
}

interface TranscriptPromptProps {
  readonly composerAttachments: ReadonlyArray<ComposerImageAttachment>;
  readonly draftValue: string;
  readonly interactionMode: "default" | "plan";
  readonly loading: boolean;
  readonly paneActive: boolean;
  readonly promptFocusDisabled: boolean;
  readonly promptInputDisabled: boolean;
  readonly submitDisabled: boolean;
  onAddImageFiles?(files: ReadonlyArray<File>): void;
  onDraftChange?(value: string): void;
  onRemoveImage?(attachmentId: string): void;
  onSubmit?(value: string): Promise<void> | void;
}

export function hasNonCollapsedSelectionInsideElement(element: HTMLElement | null) {
  if (!element || typeof window === "undefined") {
    return false;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return false;
  }
  const range = selection.getRangeAt(0);
  return element.contains(range.startContainer) || element.contains(range.endContainer);
}

function syncTextareaHeight(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return;
  }
  textarea.style.height = "0px";
  textarea.style.height = `${Math.max(textarea.scrollHeight, 52)}px`;
}

function toImageFiles(fileList: FileList | null) {
  return [...(fileList ?? [])].filter((file) => file.type.startsWith("image/"));
}

const TranscriptPrompt = memo(forwardRef<TranscriptPromptHandle, TranscriptPromptProps>(
  function TranscriptPrompt(
    {
      composerAttachments,
      draftValue,
      interactionMode,
      loading,
      paneActive,
      promptFocusDisabled,
      promptInputDisabled,
      submitDisabled,
      onAddImageFiles,
      onDraftChange,
      onRemoveImage,
      onSubmit,
    },
    ref,
  ) {
    const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const promptInputShellRef = useRef<HTMLDivElement | null>(null);
    const promptMeasureRef = useRef<HTMLDivElement | null>(null);
    const promptMeasureTextRef = useRef<HTMLSpanElement | null>(null);
    const promptCaretProbeRef = useRef<HTMLSpanElement | null>(null);
    const draftRef = useRef(draftValue);
    const textareaHeightFrameRef = useRef<number | null>(null);
    const caretFrameRef = useRef<number | null>(null);
    const submittingRef = useRef(false);
    const [hasPromptFocus, setHasPromptFocus] = useState(false);
    const [customCaretStyle, setCustomCaretStyle] = useState<{
      readonly left: number;
      readonly top: number;
      readonly width: number;
      readonly height: number;
    } | null>(null);
    const showCustomCaret = paneActive && !hasPromptFocus;

    useEffect(() => {
      if (!paneActive && document.activeElement === promptTextareaRef.current) {
        promptTextareaRef.current?.blur();
      }
    }, [paneActive]);

    const focusPrompt = useCallback(() => {
      if (promptFocusDisabled) {
        return;
      }
      promptTextareaRef.current?.focus();
    }, [promptFocusDisabled]);

    const scheduleTextareaHeightSync = useCallback((textarea: HTMLTextAreaElement | null = promptTextareaRef.current) => {
      if (!textarea) {
        return;
      }
      if (textareaHeightFrameRef.current !== null) {
        cancelAnimationFrame(textareaHeightFrameRef.current);
      }
      textareaHeightFrameRef.current = requestAnimationFrame(() => {
        textareaHeightFrameRef.current = null;
        syncTextareaHeight(textarea);
      });
    }, []);

    const scheduleCustomCaretSync = useCallback(() => {
      if (caretFrameRef.current !== null) {
        cancelAnimationFrame(caretFrameRef.current);
      }
      caretFrameRef.current = requestAnimationFrame(() => {
        caretFrameRef.current = null;
        const textarea = promptTextareaRef.current;
        const shell = promptInputShellRef.current;
        const measure = promptMeasureRef.current;
        const measureText = promptMeasureTextRef.current;
        const probe = promptCaretProbeRef.current;
        if (!textarea || !shell || !measure || !measureText || !probe) {
          setCustomCaretStyle(null);
          return;
        }
        const selectionStart = textarea.selectionStart ?? draftRef.current.length;
        measure.style.width = `${shell.clientWidth}px`;
        measureText.textContent = draftRef.current.slice(0, selectionStart) || "\u200b";
        const shellRect = shell.getBoundingClientRect();
        const probeRect = probe.getBoundingClientRect();
        setCustomCaretStyle({
          left: probeRect.left - shellRect.left,
          top: probeRect.top - shellRect.top,
          width: Math.max(probeRect.width, 8),
          height: Math.max(probeRect.height, 16),
        });
      });
    }, []);

    const setDraftValue = useCallback((nextDraft: string, options?: { readonly notifyParent?: boolean }) => {
      draftRef.current = nextDraft;
      const textarea = promptTextareaRef.current;
      if (textarea && textarea.value !== nextDraft) {
        textarea.value = nextDraft;
      }
      if (options?.notifyParent !== false) {
        onDraftChange?.(nextDraft);
      }
      scheduleTextareaHeightSync(textarea);
      scheduleCustomCaretSync();
    }, [onDraftChange, scheduleCustomCaretSync, scheduleTextareaHeightSync]);

    useEffect(() => {
      if (draftRef.current !== draftValue) {
        if (promptTextareaRef.current && document.activeElement === promptTextareaRef.current) {
          return;
        }
        setDraftValue(draftValue, { notifyParent: false });
      }
    }, [draftValue, setDraftValue]);

    useLayoutEffect(() => {
      scheduleTextareaHeightSync();
      scheduleCustomCaretSync();
    }, [composerAttachments.length, draftValue, scheduleCustomCaretSync, scheduleTextareaHeightSync]);

    useEffect(() => () => {
      if (textareaHeightFrameRef.current !== null) {
        cancelAnimationFrame(textareaHeightFrameRef.current);
      }
      if (caretFrameRef.current !== null) {
        cancelAnimationFrame(caretFrameRef.current);
      }
    }, []);

    const insertPromptText = useCallback((text: string) => {
      const textarea = promptTextareaRef.current;
      if (!textarea) {
        setDraftValue(draftRef.current + text);
        return;
      }
      const selectionStart = textarea.selectionStart ?? draftRef.current.length;
      const selectionEnd = textarea.selectionEnd ?? draftRef.current.length;
      const nextDraft = draftRef.current.slice(0, selectionStart) + text + draftRef.current.slice(selectionEnd);
      setDraftValue(nextDraft);
      const nextCursor = selectionStart + text.length;
      requestAnimationFrame(() => {
        textarea.selectionStart = nextCursor;
        textarea.selectionEnd = nextCursor;
        focusPrompt();
        scheduleCustomCaretSync();
      });
    }, [focusPrompt, scheduleCustomCaretSync, setDraftValue]);

    const deletePromptText = useCallback((direction: "backward" | "forward") => {
      const textarea = promptTextareaRef.current;
      const selectionStart = textarea?.selectionStart ?? draftRef.current.length;
      const selectionEnd = textarea?.selectionEnd ?? draftRef.current.length;
      if (selectionStart === selectionEnd) {
        if (direction === "backward" && selectionStart === 0) {
          return;
        }
        if (direction === "forward" && selectionEnd >= draftRef.current.length) {
          return;
        }
      }
      const deleteFrom =
        selectionStart === selectionEnd
          ? direction === "backward"
            ? selectionStart - 1
            : selectionStart
          : selectionStart;
      const deleteTo =
        selectionStart === selectionEnd
          ? direction === "backward"
            ? selectionStart
            : selectionEnd + 1
          : selectionEnd;
      const nextDraft = draftRef.current.slice(0, deleteFrom) + draftRef.current.slice(deleteTo);
      setDraftValue(nextDraft);
      requestAnimationFrame(() => {
        if (!textarea) {
          return;
        }
        textarea.selectionStart = deleteFrom;
        textarea.selectionEnd = deleteFrom;
        focusPrompt();
        scheduleCustomCaretSync();
      });
    }, [focusPrompt, scheduleCustomCaretSync, setDraftValue]);

    const submitPrompt = useCallback(async () => {
      const value = draftRef.current.trim();
      if ((value.length === 0 && composerAttachments.length === 0) || submitDisabled || promptInputDisabled || submittingRef.current) {
        return;
      }
      submittingRef.current = true;
      try {
        await onSubmit?.(draftRef.current);
        setDraftValue("");
      } finally {
        submittingRef.current = false;
        requestAnimationFrame(() => {
          scheduleTextareaHeightSync();
          focusPrompt();
          scheduleCustomCaretSync();
        });
      }
    }, [composerAttachments.length, focusPrompt, onSubmit, promptInputDisabled, scheduleCustomCaretSync, scheduleTextareaHeightSync, setDraftValue, submitDisabled]);

    useEffect(() => {
      const textarea = promptTextareaRef.current;
      if (!textarea) {
        return;
      }

      const handleInput = () => {
        draftRef.current = textarea.value;
        onDraftChange?.(textarea.value);
        scheduleTextareaHeightSync(textarea);
        scheduleCustomCaretSync();
      };

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.isComposing) {
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          void submitPrompt();
        }
      };

      const handlePaste = (event: ClipboardEvent) => {
        const imageFiles = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
        if (imageFiles.length === 0) {
          return;
        }
        event.preventDefault();
        onAddImageFiles?.(imageFiles);
        focusPrompt();
      };

      const handleFocus = () => {
        setHasPromptFocus(true);
        scheduleCustomCaretSync();
      };

      const handleBlur = () => {
        setHasPromptFocus(false);
        scheduleCustomCaretSync();
      };

      const handleSelect = () => {
        scheduleCustomCaretSync();
      };

      textarea.addEventListener("input", handleInput);
      textarea.addEventListener("keydown", handleKeyDown);
      textarea.addEventListener("paste", handlePaste);
      textarea.addEventListener("focus", handleFocus);
      textarea.addEventListener("blur", handleBlur);
      textarea.addEventListener("select", handleSelect);
      window.addEventListener("resize", scheduleCustomCaretSync);
      return () => {
        textarea.removeEventListener("input", handleInput);
        textarea.removeEventListener("keydown", handleKeyDown);
        textarea.removeEventListener("paste", handlePaste);
        textarea.removeEventListener("focus", handleFocus);
        textarea.removeEventListener("blur", handleBlur);
        textarea.removeEventListener("select", handleSelect);
        window.removeEventListener("resize", scheduleCustomCaretSync);
      };
    }, [focusPrompt, onAddImageFiles, onDraftChange, scheduleCustomCaretSync, scheduleTextareaHeightSync, submitPrompt]);

    useImperativeHandle(ref, () => ({
      focusPrompt,
      insertPromptText,
      deletePromptBackward() {
        deletePromptText("backward");
      },
      deletePromptForward() {
        deletePromptText("forward");
      },
      submitPrompt() {
        void submitPrompt();
      },
    }), [deletePromptText, focusPrompt, insertPromptText, submitPrompt]);

    return (
      <div
        className={`transcript-prompt${interactionMode === "plan" ? " transcript-prompt--compact" : ""}${loading ? " transcript-prompt--loading" : ""}`}
      >
        <div className="transcript-prompt__body">
          {composerAttachments.length > 0 ? (
            <div className="transcript-prompt__attachments">
              {composerAttachments.map((attachment) => (
                <div key={attachment.id} className="transcript-prompt__attachmentChip">
                  <span>{attachment.name}</span>
                  {onRemoveImage ? (
                    <button type="button" onClick={() => onRemoveImage(attachment.id)} aria-label={`Remove ${attachment.name}`}>
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <div className="transcript-prompt__row">
            <div className="transcript-prompt__marker" aria-hidden="true">›</div>
            <div ref={promptInputShellRef} className="transcript-prompt__inputShell">
              <textarea
                ref={promptTextareaRef}
                className={`transcript-prompt__input${showCustomCaret ? " transcript-prompt__input--customCaret" : " transcript-prompt__input--nativeCaret"}`}
                defaultValue={draftValue}
                spellCheck={false}
                disabled={promptInputDisabled}
              />
              <div ref={promptMeasureRef} className="transcript-prompt__measure" aria-hidden="true">
                <span ref={promptMeasureTextRef} />
                <span ref={promptCaretProbeRef}> </span>
              </div>
              <div
                className="transcript-prompt__customCaret"
                hidden={!showCustomCaret || !customCaretStyle}
                style={customCaretStyle
                  ? {
                    left: `${customCaretStyle.left}px`,
                    top: `${customCaretStyle.top}px`,
                    width: `${customCaretStyle.width}px`,
                    height: `${customCaretStyle.height}px`,
                  }
                  : undefined}
              />
            </div>
          </div>
        </div>
      </div>
    );
  },
));

TranscriptPrompt.displayName = "TranscriptPrompt";

export const TranscriptRenderer = forwardRef<TranscriptRendererHandle, TranscriptRendererProps>(
  function TranscriptRenderer(
    {
      composerAttachments = [],
      draftValue = "",
      getTurnDiff,
      projectRoot,
      thread = null,
      initialScrollOffsetFromBottom,
      paneActive = false,
      interactionMode = "default",
      loading = false,
      loadingLabel = null,
      promptFocusDisabled = false,
      promptInputDisabled = false,
      submitDisabled = false,
      onAddImageFiles,
      onDraftChange,
      onRemoveImage,
      onScrollOffsetFromBottomChange,
      onThreadRenderReady,
      onSubmit,
    },
    ref,
  ) {
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const historyRef = useRef<HTMLDivElement | null>(null);
    const promptHandleRef = useRef<TranscriptPromptHandle | null>(null);
    const onAddImageFilesRef = useRef(onAddImageFiles);
    const onDraftChangeRef = useRef(onDraftChange);
    const onRemoveImageRef = useRef(onRemoveImage);
    const onSubmitRef = useRef(onSubmit);
    const [dragOver, setDragOver] = useState(false);
    const effectiveLoadingLabel = loadingLabel;
    const isLoading = loading;

    useEffect(() => {
      onAddImageFilesRef.current = onAddImageFiles;
      onDraftChangeRef.current = onDraftChange;
      onRemoveImageRef.current = onRemoveImage;
      onSubmitRef.current = onSubmit;
    }, [onAddImageFiles, onDraftChange, onRemoveImage, onSubmit]);

    const handlePromptAddImageFiles = useCallback((files: ReadonlyArray<File>) => {
      onAddImageFilesRef.current?.(files);
    }, []);

    const handlePromptDraftChange = useCallback((value: string) => {
      onDraftChangeRef.current?.(value);
    }, []);

    const handlePromptRemoveImage = useCallback((attachmentId: string) => {
      onRemoveImageRef.current?.(attachmentId);
    }, []);

    const handlePromptSubmit = useCallback((value: string) => onSubmitRef.current?.(value), []);

    const handleSurfaceDragEnter = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
      if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
        event.preventDefault();
        setDragOver(true);
      }
    }, []);

    const handleSurfaceDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
      if ([...event.dataTransfer.items].some((item) => item.kind === "file")) {
        event.preventDefault();
      }
    }, []);

    const handleSurfaceDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
      if (!surfaceRef.current?.contains(event.relatedTarget as Node | null)) {
        setDragOver(false);
      }
    }, []);

    const handleSurfaceDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
      const imageFiles = toImageFiles(event.dataTransfer.files);
      if (imageFiles.length === 0) {
        setDragOver(false);
        return;
      }
      event.preventDefault();
      setDragOver(false);
      onAddImageFilesRef.current?.(imageFiles);
      promptHandleRef.current?.focusPrompt();
    }, []);

    useImperativeHandle(ref, () => ({
      focus() {
        promptHandleRef.current?.focusPrompt();
      },
      focusPrompt() {
        promptHandleRef.current?.focusPrompt();
      },
      focusHistory() {
        historyRef.current?.focus();
      },
      hasFocusWithinPane() {
        return Boolean(surfaceRef.current && surfaceRef.current.contains(document.activeElement));
      },
      openSearch() {},
      isHistoryActive() {
        return document.activeElement === historyRef.current;
      },
      hasHistorySelection() {
        return hasNonCollapsedSelectionInsideElement(historyRef.current);
      },
      selectAllHistory() {
        const historyElement = historyRef.current;
        if (!historyElement || typeof window === "undefined") {
          return false;
        }
        const selection = window.getSelection();
        if (!selection) {
          return false;
        }
        const range = document.createRange();
        range.selectNodeContents(historyElement);
        selection.removeAllRanges();
        selection.addRange(range);
        historyElement.focus();
        return true;
      },
      insertPromptText(text: string) {
        promptHandleRef.current?.insertPromptText(text);
      },
      deletePromptBackward() {
        promptHandleRef.current?.deletePromptBackward();
      },
      deletePromptForward() {
        promptHandleRef.current?.deletePromptForward();
      },
      submitPrompt() {
        promptHandleRef.current?.submitPrompt();
      },
      scrollToBottom() {
        const historyElement = historyRef.current;
        if (!historyElement) {
          return;
        }
        historyElement.scrollTop = historyElement.scrollHeight;
      },
    }), []);

    return (
      <div
        ref={surfaceRef}
        className={`transcript-surface${dragOver ? " transcript-surface--drag-over" : ""}`}
        onDragEnter={handleSurfaceDragEnter}
        onDragOver={handleSurfaceDragOver}
        onDragLeave={handleSurfaceDragLeave}
        onDrop={handleSurfaceDrop}
      >
        <div
          ref={historyRef}
          className={`transcript-history${isLoading ? " transcript-history--loading" : ""}`}
          tabIndex={-1}
          aria-label="Conversation history"
          aria-busy={isLoading}
        >
          <TranscriptHistory
            getTurnDiff={getTurnDiff}
            projectRoot={projectRoot}
            thread={thread}
            initialScrollOffsetFromBottom={initialScrollOffsetFromBottom}
            onScrollOffsetFromBottomChange={onScrollOffsetFromBottomChange}
            onThreadRenderReady={onThreadRenderReady}
            scrollContainerRef={historyRef}
          />
        </div>
        <TranscriptPrompt
          ref={promptHandleRef}
          composerAttachments={composerAttachments}
          draftValue={draftValue}
          interactionMode={interactionMode}
          loading={isLoading}
          paneActive={paneActive}
          promptFocusDisabled={promptFocusDisabled || isLoading}
          promptInputDisabled={promptInputDisabled || isLoading}
          submitDisabled={submitDisabled || isLoading}
          onAddImageFiles={handlePromptAddImageFiles}
          onDraftChange={handlePromptDraftChange}
          onRemoveImage={handlePromptRemoveImage}
          onSubmit={handlePromptSubmit}
        />
        {effectiveLoadingLabel ? (
          <div className="transcript-surface__loadingScreen" aria-live="polite" aria-busy="true">
            <AnimatedLoadingText text={effectiveLoadingLabel} className="loading-screen__text" />
          </div>
        ) : null}
      </div>
    );
  },
);
