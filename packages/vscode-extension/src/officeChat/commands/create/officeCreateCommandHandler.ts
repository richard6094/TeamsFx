// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  CancellationToken,
  ChatContext,
  ChatRequest,
  ChatResponseStream,
  LanguageModelChatUserMessage,
} from "vscode";

import { OfficeChatCommand, officeChatParticipantId } from "../../consts";
import { verbatimCopilotInteraction } from "../../../chat/utils";
import { isInputHarmful } from "../../utils";
import { ICopilotChatResult } from "../../../chat/types";
import { describeOfficeProjectSystemPrompt } from "../../officePrompts";
import { TelemetryEvent } from "../../../telemetry/extTelemetryEvents";
import { ExtTelemetry } from "../../../telemetry/extTelemetry";
import { ChatTelemetryData } from "../../../chat/telemetry";
import { showFileTree } from "../../../chat/commands/create/helper";
import { matchOfficeProject, showTemplateFileTree } from "./helper";
import { localize } from "../../../utils/localizeUtils";
import { Planner } from "../../common/planner";
import { CHAT_CREATE_SAMPLE_COMMAND_ID } from "../../../chat/consts";

export default async function officeCreateCommandHandler(
  request: ChatRequest,
  context: ChatContext,
  response: ChatResponseStream,
  token: CancellationToken
): Promise<ICopilotChatResult> {
  const officeChatTelemetryData = ChatTelemetryData.createByParticipant(
    officeChatParticipantId,
    OfficeChatCommand.Create,
    request.location
  );
  ExtTelemetry.sendTelemetryEvent(
    TelemetryEvent.CopilotChatStart,
    officeChatTelemetryData.properties
  );
  const isHarmful = await isInputHarmful(request, token);
  if (!isHarmful) {
    const matchedResult = await matchOfficeProject(request, token, officeChatTelemetryData);
    if (matchedResult) {
      const describeProjectChatMessages = [
        describeOfficeProjectSystemPrompt,
        new LanguageModelChatUserMessage(
          `The project you are looking for is '${JSON.stringify(matchedResult)}'.`
        ),
      ];
      officeChatTelemetryData.chatMessages.push(...describeProjectChatMessages);

      await verbatimCopilotInteraction(
        "copilot-gpt-3.5-turbo",
        describeProjectChatMessages,
        response,
        token
      );
      if (matchedResult.type === "sample") {
        const folder = await showFileTree(matchedResult, response);
        const sampleTitle = localize("teamstoolkit.chatParticipants.create.sample");
        response.button({
          command: CHAT_CREATE_SAMPLE_COMMAND_ID,
          arguments: [folder],
          title: sampleTitle,
        });
      } else if (matchedResult.type === "template") {
        response.markdown(
          "\nWe've found a template project that matches your description. Take a look at it below."
        );
        const tmpFolder = await showTemplateFileTree(matchedResult.data, response);
        const templateTitle = localize("teamstoolkit.chatParticipants.create.template");
        response.button({
          command: CHAT_CREATE_SAMPLE_COMMAND_ID,
          arguments: [tmpFolder],
          title: templateTitle,
        });
      }
    } else {
      return await Planner.getInstance().processRequest(
        new LanguageModelChatUserMessage(request.prompt),
        request,
        response,
        token,
        OfficeChatCommand.Create,
        officeChatTelemetryData
      );
    }
  } else {
    response.markdown(localize("teamstoolkit.chatParticipants.officeAddIn.harmfulInputResponse"));
  }
  officeChatTelemetryData.markComplete();
  ExtTelemetry.sendTelemetryEvent(
    TelemetryEvent.CopilotChat,
    officeChatTelemetryData.properties,
    officeChatTelemetryData.measurements
  );
  return {
    metadata: {
      command: OfficeChatCommand.Create,
      requestId: officeChatTelemetryData.requestId,
    },
  };
}
