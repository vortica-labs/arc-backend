import type { Request, Response } from "express";
import { z } from "zod";
import { chatService } from "./chat.service";

const sendMessageSchema = z.object({
  chatId: z.string().min(1),
  text: z.string().trim().min(1).max(1000)
});

export const chatController = {
  async getRecentMessages(req: Request, res: Response) {
    const chatId = req.params.chatId;
    const userId = String((req as Request & { userId?: string }).userId ?? "");
    try {
      const messages = await chatService.getRecentMessages(chatId, userId);
      res.json({ success: true, data: messages });
    } catch (error) {
      const status = Number((error as { statusCode?: number }).statusCode) || 500;
      res.status(status).json({ success: false, message: status === 403 ? "Chat not found or access denied" : "Failed to fetch messages" });
    }
  },

  async sendMessage(req: Request, res: Response) {
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, errors: parsed.error.flatten().fieldErrors });
    }

    const senderId = String((req as Request & { userId?: string }).userId ?? "");
    if (!senderId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    try {
      const message = await chatService.postMessage({
        chatId: parsed.data.chatId,
        senderId,
        text: parsed.data.text
      });
      return res.status(201).json({ success: true, data: message });
    } catch (error) {
      const status = Number((error as { statusCode?: number }).statusCode) || 500;
      return res.status(status).json({ success: false, message: status === 403 ? "Chat not found or access denied" : "Failed to send message" });
    }
  }
};
