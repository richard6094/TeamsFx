// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as tmp from "tmp";
import * as crypto from "crypto";
import * as officeTemplateMeatdata from "./officeTemplateMetadata.json";
import * as fs from "fs-extra";
import * as path from "path";
import * as vscode from "vscode";
import {
  ChatRequest,
  CancellationToken,
  LanguageModelChatUserMessage,
  ChatResponseStream,
  ChatResponseFileTree,
  Uri,
} from "vscode";
import { IChatTelemetryData } from "../../../chat/types";
import { ProjectMetadata } from "../../../chat/commands/create/types";
import { getCopilotResponseAsString } from "../../../chat/utils";
import { BM25, BMDocument, DocumentWithmetadata } from "../../retrievalUtil/BM25";
import { prepareDiscription } from "../../retrievalUtil/retrievalUtil";
import { getOfficeProjectMatchSystemPrompt } from "../../officePrompts";
import { sampleProvider } from "@microsoft/teamsfx-core";
import { CommandKey } from "../../../constants";
import { TelemetryTriggerFrom } from "../../../telemetry/extTelemetryEvents";
import { CHAT_EXECUTE_COMMAND_ID } from "../../../chat/consts";
import { fileTreeAdd } from "../../../chat/commands/create/helper";

export async function matchOfficeProject(
  request: ChatRequest,
  token: CancellationToken,
  telemetryMetadata: IChatTelemetryData
): Promise<ProjectMetadata | undefined> {
  const allOfficeProjectMetadata = [
    ...getOfficeTemplateMetadata(),
    ...(await getOfficeSampleMetadata()),
  ];
  const messages = [
    getOfficeProjectMatchSystemPrompt(allOfficeProjectMetadata),
    new LanguageModelChatUserMessage(request.prompt),
  ];
  telemetryMetadata.chatMessages.push(...messages);
  const response = await getCopilotResponseAsString("copilot-gpt-4", messages, token);
  let matchedProjectId: string;
  if (response) {
    try {
      const responseJson = JSON.parse(response);
      if (responseJson && responseJson.addin) {
        matchedProjectId = responseJson.addin;
      }
    } catch (e) {}
  }
  let result: ProjectMetadata | undefined;
  const matchedProject = allOfficeProjectMetadata.find((config) => config.id === matchedProjectId);
  if (matchedProject) {
    result = matchedProject;
  }
  return result;
}

export async function getOfficeSampleMetadata(): Promise<ProjectMetadata[]> {
  const sampleCollection = await sampleProvider.SampleCollection;
  const result: ProjectMetadata[] = [];
  for (const sample of sampleCollection.samples) {
    if (
      sample.types.includes("Word") ||
      sample.types.includes("Excel") ||
      sample.types.includes("Powerpoint")
    ) {
      result.push({
        id: sample.id,
        type: "sample",
        platform: "WXP",
        name: sample.title,
        description: sample.fullDescription,
      });
    }
  }
  return result;
}

export function getOfficeTemplateMetadata(): ProjectMetadata[] {
  return officeTemplateMeatdata.map((config) => {
    return {
      id: config.id,
      type: "template",
      platform: "WXP",
      name: config.name,
      description: config.description,
      data: {
        capabilities: config.id,
        "project-type": config["project-type"],
        "addin-host": config["addin-host"],
        agent: "office",
        "programming-language": "typescript",
      },
    };
  });
}

export async function showTemplateFileTree(
  data: any,
  response: ChatResponseStream,
  codeSnippet?: string
): Promise<string> {
  const tempFolder = tmp.dirSync({ unsafeCleanup: true }).name;
  const tempAppName = `office-addin-${crypto.randomBytes(8).toString("hex")}`;
  const nodes = await buildTemplateFileTree(data, tempFolder, tempAppName, codeSnippet);
  response.filetree(nodes, Uri.file(path.join(tempFolder, tempAppName)));
  return path.join(tempFolder, tempAppName);
}

export async function buildTemplateFileTree(
  data: any,
  tempFolder: string,
  tempAppName: string,
  codeSnippet?: string
): Promise<ChatResponseFileTree[]> {
  const createInputs = {
    ...data,
    folder: tempFolder,
    "app-name": tempAppName,
  };
  await vscode.commands.executeCommand(
    CHAT_EXECUTE_COMMAND_ID,
    CommandKey.Create,
    TelemetryTriggerFrom.CopilotChat,
    createInputs
  );
  const rootFolder = path.join(tempFolder, tempAppName);
  const isCustomFunction = data.capabilities.includes("excel-cf");
  if (!!isCustomFunction && !!codeSnippet) {
    await mergeCFCode(rootFolder, codeSnippet);
  } else if (!!codeSnippet) {
    await mergeTaskpaneCode(rootFolder, codeSnippet);
  }
  const root: ChatResponseFileTree = {
    name: rootFolder,
    children: [],
  };
  traverseFiles(rootFolder, (fullPath) => {
    const relativePath = path.relative(rootFolder, fullPath);
    fileTreeAdd(root, relativePath);
  });
  return root.children ?? [];
}

export async function matchOfficeProjectByBM25(
  request: ChatRequest
): Promise<ProjectMetadata | undefined> {
  const allOfficeProjectMetadata = [
    ...getOfficeTemplateMetadata(),
    ...(await getOfficeSampleMetadata()),
  ];
  const documents: DocumentWithmetadata[] = allOfficeProjectMetadata.map((sample) => {
    return {
      documentText: prepareDiscription(sample.description.toLowerCase()).join(" "),
      metadata: sample,
    };
  });

  const bm25 = new BM25(documents);
  const query = prepareDiscription(request.prompt.toLowerCase());

  // at most match one sample or template
  const matchedDocuments: BMDocument[] = bm25.search(query, 3);

  // adjust score when more samples added
  if (matchedDocuments.length === 1 && matchedDocuments[0].score > 1) {
    return matchedDocuments[0].document.metadata as ProjectMetadata;
  }

  return undefined;
}

function traverseFiles(dir: string, callback: (relativePath: string) => void): void {
  fs.readdirSync(dir).forEach((file) => {
    const fullPath = path.join(dir, file);
    if (fs.lstatSync(fullPath).isDirectory()) {
      traverseFiles(fullPath, callback);
    } else {
      callback(fullPath);
    }
  });
}

async function mergeTaskpaneCode(filePath: string, generatedCode: string) {
  const tsFileUri = vscode.Uri.file(path.join(filePath, "src", "taskpane", "taskpane.ts"));
  const htmlFileUri = vscode.Uri.file(path.join(filePath, "src", "taskpane", "taskpane.html"));

  try {
    // Read the file
    const tsFileData = await vscode.workspace.fs.readFile(tsFileUri);
    const tsFileContent: string = tsFileData.toString();
    const htmlFileData = await vscode.workspace.fs.readFile(htmlFileUri);
    const htmlFileContent: string = htmlFileData.toString();

    // Replace the code snippet part in taskpane.ts
    const runFunctionStart = tsFileContent.indexOf("export async function run()");
    const runFunctionEnd: number = tsFileContent.lastIndexOf("}");
    const runFunction = tsFileContent.slice(runFunctionStart, runFunctionEnd + 1);
    let modifiedTSContent = tsFileContent.replace(runFunction, generatedCode);
    // Replace the onClick event
    const mapStartIndex = modifiedTSContent.indexOf(`document.getElementById("run").onclick = run`);
    const mapEndIndex = mapStartIndex + `document.getElementById("run").onclick = run`.length;
    const map = modifiedTSContent.slice(mapStartIndex, mapEndIndex);
    modifiedTSContent = modifiedTSContent.replace(
      map,
      `document.getElementById("run").onclick = main`
    );

    // Update the HTML content
    const ulStart = htmlFileContent.indexOf('<ul class="ms-List ms-welcome__features">');
    const ulEnd = htmlFileContent.indexOf("</ul>") + "</ul>".length;
    const ulSection = htmlFileContent.slice(ulStart, ulEnd);
    const htmlIntroduction = `<p class="ms-font-l"> This is an add-in generated by Office Agent in GitHub Copilot</p>`;
    const modifiedHtmlContent = htmlFileContent.replace(ulSection, htmlIntroduction);

    // Write the modified content back to the file
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(tsFileUri, encoder.encode(modifiedTSContent));
    await vscode.workspace.fs.writeFile(htmlFileUri, encoder.encode(modifiedHtmlContent));
  } catch (error) {
    console.error("Failed to modify file", error);
  }
}

async function mergeCFCode(filePath: string, generatedCode: string) {
  const functionFileUri = vscode.Uri.file(path.join(filePath, "src", "functions", "functions.ts"));
  try {
    // Read the file
    const functionFileData = await vscode.workspace.fs.readFile(functionFileUri);
    const functionFileContent: string = functionFileData.toString();
    // Add the new function to functions.ts
    const modifiedFunctionContent = "\n" + functionFileContent + generatedCode + "\n";
    // Write the modified content back to the file
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(functionFileUri, encoder.encode(modifiedFunctionContent));
  } catch (error) {
    console.error("Failed to modify file", error);
  }
}
