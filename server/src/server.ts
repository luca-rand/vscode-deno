import * as path from "path";
import { promises as fs } from "fs";

import {
  IPCMessageReader,
  IPCMessageWriter,
  createConnection,
  IConnection,
  TextDocuments,
  InitializeResult,
  Range,
  TextEdit,
  CompletionItem,
  CompletionItemKind,
  Position
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";

import { deno, FormatableLanguages } from "./deno";
import { isFilepathExist } from "./utils";

const configurationNamespace = "deno";

process.title = "Deno Language Server";

// The workspace folder this server is operating on
let workspaceFolder: string = process.cwd();

// The example settings
interface ISettings {
  enable: boolean;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ISettings = { enable: true };
let globalSettings: ISettings = defaultSettings;

// Create a connection for the server. The connection uses Node's IPC as a transport
const connection: IConnection = createConnection(
  new IPCMessageReader(process),
  new IPCMessageWriter(process)
);

// Create a simple text document manager. The text document manager
// supports full document sync only
const documents = new TextDocuments(TextDocument);

connection.onInitialize(
  (params): InitializeResult => {
    return {
      serverInfo: {
        name: process.title
      },
      capabilities: {
        documentFormattingProvider: true,
        completionProvider: {
          triggerCharacters: ["http", "https"]
        }
      }
    };
  }
);

connection.onInitialized(async () => {
  try {
    await deno.init();
    const currentDenoTypesContent = await deno.getTypes();
    const isExistDtsFile = await isFilepathExist(deno.dtsFilepath);
    const fileOptions = { encoding: "utf8" };

    // if dst file not exist. then create a new one
    if (!isExistDtsFile) {
      await fs.writeFile(
        deno.dtsFilepath,
        currentDenoTypesContent,
        fileOptions
      );
    } else {
      const typesContent = await fs.readFile(deno.dtsFilepath, fileOptions);

      if (typesContent.toString() !== currentDenoTypesContent.toString()) {
        await fs.writeFile(
          deno.dtsFilepath,
          currentDenoTypesContent,
          fileOptions
        );
      }
    }
  } catch (err) {
    connection.sendNotification("error", err.message);
    return;
  }
  connection.sendNotification("init", {
    version: deno.version ? deno.version.deno : undefined,
    executablePath: deno.executablePath,
    DENO_DIR: deno.DENO_DIR,
    dtsFilepath: deno.dtsFilepath
  });
  connection.console.log("server initialized.");
});

connection.onDocumentFormatting(async params => {
  if (!globalSettings.enable) {
    return [];
  }
  const uri = params.textDocument.uri;
  const doc = documents.get(uri);

  if (!doc) {
    return;
  }

  const text = doc.getText();

  const formatted = await deno.format(
    text,
    doc.languageId as FormatableLanguages,
    {
      cwd: workspaceFolder
    }
  );

  const start = doc.positionAt(0);
  const end = doc.positionAt(text.length);

  const range = Range.create(start, end);

  return [TextEdit.replace(range, formatted)];
});

interface Deps {
  url: string;
  filepath: string;
}

async function getDepsFile(
  rootDir = deno.DENO_DEPS_DIR,
  deps: Deps[] = []
): Promise<Deps[]> {
  const files = await fs.readdir(rootDir);

  const promises = files.map(filename => {
    const filepath = path.join(rootDir, filename);
    return fs.stat(filepath).then(stat => {
      if (stat.isDirectory()) {
        return getDepsFile(filepath, deps);
      } else if (
        stat.isFile() &&
        /\.tsx?$/.test(filepath) &&
        !filepath.endsWith(".d.ts")
      ) {
        const url = filepath
          .replace(deno.DENO_DEPS_DIR, "")
          .replace(/^(\/|\\\\)/, "")
          .replace(/http(\/|\\\\)/, "http://")
          .replace(/https(\/|\\\\)/, "https://");

        deps.push({
          url: url,
          filepath: filepath
        });
      }
    });
  });

  await Promise.all(promises);

  return deps;
}

// FIXME: all completion will trigger this.
// It seem it's a bug for vscode
connection.onCompletion(async params => {
  const { position, partialResultToken, context, textDocument } = params;

  const doc = documents.get(textDocument.uri);

  if (!globalSettings.enable || !doc) {
    return [];
  }

  const currentLine = doc.getText(
    Range.create(Position.create(position.line, 0), position)
  );

  const IMPORT_REG = /import\s['"][a-zA-Z]$/;
  const IMPORT_FROM_REG = /import\s(([^\s]*)|(\*\sas\s[^\s]*))\sfrom\s['"][a-zA-Z]$/;
  const DYNAMIC_REG = /import\s*\(['"][a-zA-Z]$/;

  const isImport =
    IMPORT_REG.test(currentLine) || // import "https://xxxx.xxxx"
    IMPORT_FROM_REG.test(currentLine) || // import xxxx from "https://xxxx.xxxx"
    DYNAMIC_REG.test(currentLine); // import("https://xxxx.xxxx")

  if (
    currentLine.length > 1000 || // if is a large file
    !isImport
  ) {
    return [];
  }

  const deps = await getDepsFile();

  const range = Range.create(
    Position.create(position.line, position.character - 5),
    position
  );

  const completes: CompletionItem[] = deps.map(dep => {
    return {
      label: dep.url,
      detail: dep.url,
      sortText: dep.url,
      documentation: dep.filepath.replace(deno.DENO_DIR, "$DENO_DIR"),
      kind: CompletionItemKind.File,
      insertText: dep.url,
      cancel: partialResultToken,
      range: range
    } as CompletionItem;
  });

  return completes;
});

connection.onDidChangeConfiguration(change => {
  const denoConfig = (change.settings[configurationNamespace] ||
    defaultSettings) as ISettings;

  console.log(`detect config change ${JSON.stringify(denoConfig)}`);

  globalSettings = { ...globalSettings, ...denoConfig };
});

connection.onNotification("workspace", filepath => {
  workspaceFolder = filepath;
});

// connection.onDidChangeTextDocument(params => {
//   // TODO: send diagnostics
//   // connection.sendDiagnostics()
// });

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
