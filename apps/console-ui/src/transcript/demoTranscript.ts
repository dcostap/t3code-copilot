import type { TranscriptBlock } from "./TranscriptBlock";

/**
 * Build a demo transcript that exercises every block type.
 * This replaces the old prototypeDocument.ts for testing.
 */
export function buildDemoTranscript(): TranscriptBlock[] {
  return [
    {
      type: "user-message",
      text: "Find and fix a bug in @MainWindow.kt",
    },

    {
      type: "tool-call",
      label: "read_file(src/main/appi/main/MainWindow.kt)",
      status: "done",
      detail: "1,247 lines",
    },

    {
      type: "tool-call",
      label: "intellij.get_file_problems({filePath: \"src/main/appi/main/MainWindow.kt\"})",
      status: "done",
      detail: '{"errors": []}',
    },

    {
      type: "file-diff",
      path: "src/main/appi/main/MainWindow.kt",
      additions: 12,
      deletions: 9,
      lines: [
        { text: "        rightPanelRoot.add(JPanel().apply {", kind: "removed" },
        { text: "            layout = OverlayLayout(this)", kind: "removed" },
        { text: "            add(tabbedPane)", kind: "removed" },
        { text: "            add(rightPanelBackgroundPanel)", kind: "removed" },
        { text: "        })", kind: "removed" },
        { text: "", kind: "removed" },
        { text: "        rightPanelBackgroundPanel.layout = BoxLayout(rightPanelBackgroundPanel, BoxLayout.Y_AXIS)", kind: "removed" },
        { text: "        setupDwgDropSupportOnPantallasTabsArea()", kind: "removed" },
        { text: "    }", kind: "removed" },
        { text: "        rightPanelRoot.add(JPanel().apply {", kind: "added" },
        { text: "            layout = OverlayLayout(this)", kind: "added" },
        { text: "            add(tabbedPane)", kind: "added" },
        { text: "            add(rightPanelBackgroundPanel)", kind: "added" },
        { text: "        })", kind: "added" },
        { text: "", kind: "added" },
        { text: "        rightPanelBackgroundPanel.layout = BoxLayout(rightPanelBackgroundPanel, BoxLayout.Y_AXIS)", kind: "added" },
        { text: "        if (shouldEnableDwgDropSupport())", kind: "added" },
        { text: "            setupDwgDropSupportOnPantallasTabsArea()", kind: "added" },
        { text: "        else", kind: "added" },
        { text: '            logInfo("DWG DnD support disabled on this machine for crash prevention.")', kind: "added" },
        { text: "    }", kind: "added" },
      ],
    },

    { type: "divider" },

    {
      type: "assistant-text",
      text: [
        "Sí, y ya te lo dejé implementado.",
        "",
        "Cambios en MainWindow.kt:",
        "",
        "- Antes de habilitar DnD de DWG, ahora hace una comprobación en Windows:",
        "  - Busca AcShellExtension.dll en CommonProgramFiles / CommonProgramFiles(x86).",
        "  - Escanea registro (Shell Extensions\\Approved y Classes\\CLSID) buscando AcShellExtension / AcColumnHandler.",
        "- Si detecta Autodesk shell extension, desactiva DnD de DWG automáticamente y lo deja en log.",
        "- Override manual: si quieres forzarlo, usa env var APPI_FORCE_ENABLE_DWG_DND=true.",
        "",
        "Esto te evita el trigger conocido del crash desde tu lado (aunque el bug nativo siga en el shell extension).",
        "No ejecuté la app ahora; validé con inspecciones IDE y no hay errores.",
      ].join("\n"),
      streaming: false,
    },

    { type: "divider" },

    {
      type: "user-message",
      text: "Run the tests to make sure nothing broke",
    },

    {
      type: "command-exec",
      command: "cd C:\\Projects\\GLP4 && gradlew test",
      exitCode: 0,
      output: "BUILD SUCCESSFUL in 14s\n47 actionable tasks: 12 executed, 35 up-to-date",
    },

    {
      type: "approval-request",
      requestId: "req-001",
      requestKind: "command",
      detail: "gradlew build",
    },

    {
      type: "status",
      text: "Session ready.",
    },
  ];
}
