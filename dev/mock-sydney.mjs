#!/usr/bin/env node
/**
 * 独立的模拟 Sydney / BizChat 上游（开发与验收用，不参与生产镜像）。
 *
 * 用途：在没有真实 Microsoft 365 Copilot 账号时，把网关的完整链路跑起来——
 * Codex ──Responses──> M365-Codex ──WebSocket──> 本脚本。
 * 这样可以验证协议层、SSE、工具代理循环、附件注入等一切与 Microsoft 无关的行为。
 *
 * 说话方式与 apps/server/test/helpers/mockSydneyServer.ts 一致：
 * SignalR JSON 帧 + 0x1e 分隔，握手 ack，若干 STREAM_ITEM，最后 COMPLETION。
 *
 * 它是一个「假模型」，行为由简单规则决定：
 *   - invocation 带 toolResults  → 回一段引用了工具结果的最终答复；
 *   - invocation 带 tools 且用户文本命中触发词 → 回一个工具调用；
 *   - 其余情况 → 流式回一段文本，并回显收到的上下文长度，便于确认附件确实到达。
 *
 * 用法：node dev/mock-sydney.mjs [--port 4300]
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const RECORD_SEPARATOR = '';
const TYPE = { INVOCATION: 1, STREAM_ITEM: 2, COMPLETION: 3, STREAM_INVOCATION: 4, CANCEL: 5, PING: 6 };

const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 4300;

/** 命中其中任意一个词就认为「用户想让模型动手做事」，从而触发工具调用。 */
const TOOL_TRIGGERS = ['运行', '执行', '跑一下', '看看目录', 'run ', 'execute', 'list files', 'shell'];

function frame(payload) {
  return JSON.stringify(payload) + RECORD_SEPARATOR;
}

function sendText(ws, invocationId, text) {
  ws.send(
    frame({
      type: TYPE.STREAM_ITEM,
      invocationId,
      arguments: [{ messages: [{ author: 'bot', text, messageType: 'Chat' }] }],
    }),
  );
}

function sendToolCall(ws, invocationId, callId, name, args) {
  ws.send(
    frame({
      type: TYPE.STREAM_ITEM,
      invocationId,
      arguments: [{ messages: [{ author: 'bot', toolCalls: [{ callId, name, arguments: args }] }] }],
    }),
  );
}

/** 给已声明的工具编一组像样的参数：认识的工具按其语义填，不认识的给空对象。 */
function inventArguments(tool) {
  const name = tool?.name ?? '';
  const props = tool?.parameters?.properties ?? {};
  if ('command' in props) {
    // Codex 的 shell 工具：command 可能是字符串数组，也可能是字符串
    const isArray = props.command?.type === 'array';
    return JSON.stringify({ command: isArray ? ['echo', 'hello-from-mock-upstream'] : 'echo hello' });
  }
  if ('path' in props) return JSON.stringify({ path: '.' });
  if ('query' in props) return JSON.stringify({ query: 'mock query' });
  if (name.includes('weather') && 'city' in props) return JSON.stringify({ city: '北京' });
  return '{}';
}

const httpServer = createServer((req, res) => {
  if (req.url?.startsWith('/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', role: 'mock-sydney-upstream' }));
    return;
  }
  res.writeHead(426);
  res.end('Upgrade Required');
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

let connections = 0;
let invocations = 0;

wss.on('connection', (ws) => {
  connections += 1;
  console.log(`[mock] 新连接，当前 ${connections} 条`);
  let handshakeDone = false;

  ws.on('message', (data) => {
    const raw = data.toString('utf8');
    for (const part of raw.split(RECORD_SEPARATOR).filter((s) => s.length > 0)) {
      let msg;
      try {
        msg = JSON.parse(part);
      } catch {
        continue;
      }

      if (!handshakeDone && 'protocol' in msg) {
        handshakeDone = true;
        ws.send(frame({}));
        continue;
      }
      if (msg.type === TYPE.PING) {
        ws.send(frame({ type: TYPE.PING }));
        continue;
      }
      if (msg.type === TYPE.CANCEL) {
        console.log('[mock] 收到取消:', msg.invocationId);
        continue;
      }
      if (msg.type !== TYPE.STREAM_INVOCATION && msg.type !== TYPE.INVOCATION) continue;

      invocations += 1;
      const invocationId = msg.invocationId ?? String(invocations);
      const arg = msg.arguments?.[0] ?? {};
      const userText = (arg.messages ?? []).find((m) => m.author === 'user')?.text ?? '';
      const tools = arg.tools ?? [];
      const toolResults = arg.toolResults ?? [];

      console.log(
        `[mock] #${invocations} 文本 ${userText.length} 字符，工具 ${tools.length} 个，工具结果 ${toolResults.length} 条`,
      );

      // 1) 带工具结果回来：给出最终答复，并把结果内容带进去，证明整条回路通了
      if (toolResults.length > 0) {
        const joined = toolResults.map((r) => String(r.output ?? '').trim()).join(' | ');
        sendText(ws, invocationId, '工具已执行完毕。');
        sendText(ws, invocationId, `返回内容是：${joined.slice(0, 400)}`);
        ws.send(frame({ type: TYPE.COMPLETION, invocationId }));
        continue;
      }

      // 2) 声明了工具且用户像是要动手做事：发起一次工具调用
      const wantsTool = TOOL_TRIGGERS.some((t) => userText.toLowerCase().includes(t.toLowerCase()));
      if (tools.length > 0 && wantsTool) {
        const tool = tools.find((t) => t.name === 'shell') ?? tools[0];
        const callId = `mockcall_${invocations}_${randomBytes(4).toString('hex')}`;
        console.log(`[mock] → 调用工具 ${tool.name}`);
        sendToolCall(ws, invocationId, callId, tool.name, inventArguments(tool));
        ws.send(frame({ type: TYPE.COMPLETION, invocationId }));
        continue;
      }

      // 3) 普通问答：分几帧流式返回，并回显上下文规模，便于确认附件已注入
      const reply = [
        '这是模拟上游的回答。',
        `我收到了 ${userText.length} 个字符的上下文`,
        tools.length > 0 ? `，以及 ${tools.length} 个可用工具。` : '。',
      ].join('');
      for (const chunk of reply.match(/.{1,12}/gu) ?? [reply]) {
        sendText(ws, invocationId, chunk);
      }
      ws.send(frame({ type: TYPE.COMPLETION, invocationId }));
    }
  });

  ws.on('close', () => {
    connections -= 1;
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock] 模拟 Sydney 上游已启动：ws://0.0.0.0:${PORT}`);
  console.log('[mock] 这是假上游，不连接任何 Microsoft 服务，也不涉及任何真实凭据。');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('[mock] 退出');
    httpServer.close(() => process.exit(0));
  });
}
