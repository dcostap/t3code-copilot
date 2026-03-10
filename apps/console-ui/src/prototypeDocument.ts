export type PrototypeLineKind =
  | "meta"
  | "body"
  | "list"
  | "toolCall"
  | "toolResult"
  | "divider"
  | "diffHeader"
  | "diffRemoved"
  | "diffAdded"
  | "diffContext";

export interface PrototypeLine {
  readonly from: number;
  readonly to: number;
  readonly kind: PrototypeLineKind;
}

export interface PrototypeDocument {
  readonly text: string;
  readonly lines: ReadonlyArray<PrototypeLine>;
}

interface BuilderLine {
  readonly text: string;
  readonly kind: PrototypeLineKind;
}

export function buildPrototypeDocument(): PrototypeDocument {
  const lines: Array<BuilderLine> = [
    { text: "", kind: "meta" },
    { text: "", kind: "meta" },
    { text: "1111", kind: "meta" },
    { text: "1048 -        rightPanelRoot.add(JPanel().apply {", kind: "diffRemoved" },
    { text: "1049 -            layout = OverlayLayout(this)", kind: "diffRemoved" },
    { text: "1050 -            add(tabbedPane)", kind: "diffRemoved" },
    { text: "1051 -            add(rightPanelBackgroundPanel)", kind: "diffRemoved" },
    { text: "1052 -        })", kind: "diffRemoved" },
    { text: "1053 -", kind: "diffRemoved" },
    { text: "1054 -        rightPanelBackgroundPanel.layout = BoxLayout(rightPanelBackgroundPanel, BoxLayout.Y_AXIS)", kind: "diffRemoved" },
    { text: "1055 -        setupDwgDropSupportOnPantallasTabsArea()", kind: "diffRemoved" },
    { text: "1056 -    }", kind: "diffRemoved" },
    { text: "1112 +        rightPanelRoot.add(JPanel().apply {", kind: "diffAdded" },
    { text: "1113 +            layout = OverlayLayout(this)", kind: "diffAdded" },
    { text: "1114 +            add(tabbedPane)", kind: "diffAdded" },
    { text: "1115 +            add(rightPanelBackgroundPanel)", kind: "diffAdded" },
    { text: "1116 +        })", kind: "diffAdded" },
    { text: "1117 +", kind: "diffAdded" },
    { text: "1118 +        rightPanelBackgroundPanel.layout = BoxLayout(rightPanelBackgroundPanel, BoxLayout.Y_AXIS)", kind: "diffAdded" },
    { text: "1119 +        if (shouldEnableDwgDropSupport())", kind: "diffAdded" },
    { text: "1120 +            setupDwgDropSupportOnPantallasTabsArea()", kind: "diffAdded" },
    { text: "1121 +        else", kind: "diffAdded" },
    { text: "1122 +            logInfo(\"DWG DnD support disabled on this machine for crash prevention.\")", kind: "diffAdded" },
    { text: "1123 +    }", kind: "diffAdded" },
    { text: "1124", kind: "meta" },
    { text: "", kind: "meta" },
    {
      text: "• Called intellij.get_file_problems({\"projectPath\":\"C:\\\\Projects\\\\GLP4\",\"filePath\":\"src/main/appi/main/MainWindow.kt\",\"errorsOnly\":false})",
      kind: "toolCall",
    },
    {
      text: "[{\"filePath\":\"src\\\\main\\\\appi\\\\main\\\\MainWindow.kt\",\"errors\":[]}]",
      kind: "toolResult",
    },
    { text: "", kind: "meta" },
    { text: "────────────────────────────────────────────────────────────────────────────────", kind: "divider" },
    { text: "", kind: "meta" },
    { text: "Sí, y ya te lo dejé implementado.", kind: "body" },
    { text: "", kind: "meta" },
    { text: "Cambios en MainWindow.kt:", kind: "body" },
    { text: "", kind: "meta" },
    {
      text: "- Antes de habilitar DnD de DWG, ahora hace una comprobación en Windows:",
      kind: "list",
    },
    {
      text: "  - Busca AcShellExtension.dll en CommonProgramFiles / CommonProgramFiles(x86).",
      kind: "list",
    },
    {
      text: "  - Escanea registro (Shell Extensions\\Approved y Classes\\CLSID) buscando AcShellExtension / AcColumnHandler.",
      kind: "list",
    },
    {
      text: "- Si detecta Autodesk shell extension, desactiva DnD de DWG automáticamente y lo deja en log.",
      kind: "list",
    },
    {
      text: "- Override manual: si quieres forzarlo, usa env var APPI_FORCE_ENABLE_DWG_DND=true.",
      kind: "list",
    },
    { text: "", kind: "meta" },
    {
      text: "Esto te evita el trigger conocido del crash desde tu lado (aunque el bug nativo siga en el shell extension).",
      kind: "body",
    },
    { text: "No ejecuté la app ahora; validé con inspecciones IDE y no hay errores.", kind: "body" },
    { text: "", kind: "meta" },
  ];

  let text = "";
  let offset = 0;
  const positionedLines: Array<PrototypeLine> = [];

  lines.forEach((line, index) => {
    const from = offset;
    text += line.text;
    offset += line.text.length;
    positionedLines.push({ from, to: offset, kind: line.kind });
    if (index < lines.length - 1) {
      text += "\n";
      offset += 1;
    }
  });

  return {
    text,
    lines: positionedLines,
  };
}
