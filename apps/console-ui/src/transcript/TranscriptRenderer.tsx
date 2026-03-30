import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { OrchestrationThread } from "@t3tools/contracts";

import type { ComposerImageAttachment } from "../composerAttachments";
import { TranscriptHistory } from "./TranscriptHistory";

interface TranscriptRendererProps {
  readonly composerAttachments?: ReadonlyArray<ComposerImageAttachment>;
  readonly cwd?: string | null;
  readonly draftValue?: string;
  readonly thread?: OrchestrationThread | null;
  readonly projectRoot?: string | null;
  readonly paneActive?: boolean;
  readonly interactionMode?: "default" | "plan";
  readonly initialScrollOffsetFromBottom?: number | null;
  readonly promptFocusDisabled?: boolean;
  readonly promptInputDisabled?: boolean;
  readonly submitDisabled?: boolean;
  onAddImageFiles?(files: ReadonlyArray<File>): void;
  onDraftChange?(value: string): void;
  onRemoveImage?(attachmentId: string): void;
  onScrollOffsetFromBottomChange?(offsetFromBottom: number): void;
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

export const TranscriptRenderer = forwardRef<TranscriptRendererHandle, TranscriptRendererProps>(
  function TranscriptRenderer(
    {
      composerAttachments = [],
      draftValue = "",
      thread = null,
      initialScrollOffsetFromBottom,
      paneActive = false,
      interactionMode = "default",
      promptFocusDisabled = false,
      promptInputDisabled = false,
      submitDisabled = false,
      onAddImageFiles,
      onDraftChange,
      onRemoveImage,
      onScrollOffsetFromBottomChange,
      onSubmit,
    },
    ref,
  ) {
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const historyRef = useRef<HTMLDivElement | null>(null);
    const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const draftRef = useRef(draftValue);
    const textareaHeightFrameRef = useRef<number | null>(null);
    const submittingRef = useRef(false);
    const onSubmitRef = useRef(onSubmit);
    const onDraftChangeRef = useRef(onDraftChange);
    const onScrollOffsetFromBottomChangeRef = useRef(onScrollOffsetFromBottomChange);
    const composerAttachmentsRef = useRef(composerAttachments);
    const [dragOver, setDragOver] = useState(false);
    const [localDraftValue, setLocalDraftValue] = useState(draftValue);

    useEffect(() => {
      onSubmitRef.current = onSubmit;
      onDraftChangeRef.current = onDraftChange;
      onScrollOffsetFromBottomChangeRef.current = onScrollOffsetFromBottomChange;
      composerAttachmentsRef.current = composerAttachments;
      onScrollOffsetFromBottomChangeRef.current?.(0);
    }, [composerAttachments, onDraftChange, onScrollOffsetFromBottomChange, onSubmit]);

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

    const setDraftValue = useCallback((nextDraft: string, options?: { readonly notifyParent?: boolean }) => {
      draftRef.current = nextDraft;
      setLocalDraftValue((existing) => existing === nextDraft ? existing : nextDraft);
      if (options?.notifyParent !== false) {
        onDraftChangeRef.current?.(nextDraft);
      }
    }, []);

    useEffect(() => {
      if (draftRef.current !== draftValue) {
        setDraftValue(draftValue, { notifyParent: false });
      }
    }, [draftValue, setDraftValue]);

    useLayoutEffect(() => {
      scheduleTextareaHeightSync();
    }, [composerAttachments.length, localDraftValue, scheduleTextareaHeightSync]);

    useEffect(() => () => {
      if (textareaHeightFrameRef.current !== null) {
        cancelAnimationFrame(textareaHeightFrameRef.current);
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
      });
    }, [focusPrompt, setDraftValue]);

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
      });
    }, [focusPrompt, setDraftValue]);

    const submitPrompt = useCallback(async () => {
      const value = draftRef.current.trim();
      if ((value.length === 0 && composerAttachmentsRef.current.length === 0) || submitDisabled || promptInputDisabled || submittingRef.current) {
        return;
      }
      submittingRef.current = true;
      try {
        await onSubmitRef.current?.(draftRef.current);
        setDraftValue("");
      } finally {
        submittingRef.current = false;
        requestAnimationFrame(() => {
          scheduleTextareaHeightSync();
          focusPrompt();
        });
      }
    }, [focusPrompt, promptInputDisabled, scheduleTextareaHeightSync, setDraftValue, submitDisabled]);

    const handlePromptChange = useCallback((event: ReactChangeEvent<HTMLTextAreaElement>) => {
      setDraftValue(event.currentTarget.value);
    }, [setDraftValue]);

    const handlePromptKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submitPrompt();
      }
    }, [submitPrompt]);

    const handlePromptPaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const imageFiles = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
      if (imageFiles.length === 0) {
        return;
      }
      event.preventDefault();
      onAddImageFiles?.(imageFiles);
      focusPrompt();
    }, [focusPrompt, onAddImageFiles]);

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
      onAddImageFiles?.(imageFiles);
      focusPrompt();
    }, [focusPrompt, onAddImageFiles]);

    useImperativeHandle(ref, () => ({
      focus() {
        focusPrompt();
      },
      focusPrompt() {
        focusPrompt();
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
        insertPromptText(text);
      },
      deletePromptBackward() {
        deletePromptText("backward");
      },
      deletePromptForward() {
        deletePromptText("forward");
      },
      submitPrompt() {
        void submitPrompt();
      },
      scrollToBottom() {
        const historyElement = historyRef.current;
        if (!historyElement) {
          return;
        }
        historyElement.scrollTop = historyElement.scrollHeight;
      },
    }), [deletePromptText, focusPrompt, insertPromptText, submitPrompt]);

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
          className="transcript-history"
          tabIndex={-1}
          aria-label="Conversation history"
        >
          <TranscriptHistory
            thread={thread}
            initialScrollOffsetFromBottom={initialScrollOffsetFromBottom}
            onScrollOffsetFromBottomChange={onScrollOffsetFromBottomChange}
            scrollContainerRef={historyRef}
          />
        </div>
        <div className={`transcript-prompt${interactionMode === "plan" ? " transcript-prompt--compact" : ""}`}>
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
              <div className="transcript-prompt__inputShell">
                <textarea
                  ref={promptTextareaRef}
                  className="transcript-prompt__input transcript-prompt__input--nativeCaret"
                  value={localDraftValue}
                  spellCheck={false}
                  disabled={promptInputDisabled}
                  onChange={handlePromptChange}
                  onKeyDown={handlePromptKeyDown}
                  onPaste={handlePromptPaste}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  },
);
