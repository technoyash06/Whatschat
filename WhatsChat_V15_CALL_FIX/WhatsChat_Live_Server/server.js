"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "whatschat-data.json");
const PROJECT_FILE = process.env.PROJECT_FILE || path.resolve(__dirname, "..", "WhatsChat_Live_TurboWarp.sb3");
const PUBLIC_PROJECT_FILE = process.env.PUBLIC_PROJECT_FILE || path.resolve(__dirname, "..", "WhatsChat_Public_TurboWarp.sb3");
const CALL_PAGE_FILE = path.join(__dirname, "call.html");
const CALL_EXTENSION_FILE = path.join(__dirname, "whatschat-call-launcher.js");
const MEDIA_PAGE_FILE = path.join(__dirname, "media.html");
const UPLOAD_DIR = path.join(path.dirname(DATA_FILE), "uploads");
const PROJECT_VERSION = "call-relay-fix-v15";
const MAX_MESSAGE_LENGTH = 1500;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const HISTORY_LIMIT = 30;
const GROUP_MEMBER_LIMIT = 20;
const GROUP_LIMIT_PER_USER = 50;

function emptyDatabase() {
  return { version: 4, users: {}, messages: [], groups: {}, groupMessages: [] };
}

function loadDatabase() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!parsed.users || !Array.isArray(parsed.messages)) throw new Error("Invalid database shape");
    let upgraded = false;
    if (Number(parsed.version || 1) < 3) {
      for (const message of parsed.messages) {
        if (!message.deliveredAt) message.deliveredAt = message.sentAt || new Date().toISOString();
      }
      upgraded = true;
    }
    if (!parsed.groups || typeof parsed.groups !== "object" || Array.isArray(parsed.groups)) {
      parsed.groups = {};
      upgraded = true;
    }
    if (!Array.isArray(parsed.groupMessages)) {
      parsed.groupMessages = [];
      upgraded = true;
    }
    if (Number(parsed.version || 1) < 4) {
      parsed.version = 4;
      upgraded = true;
    }
    if (upgraded) {
      const temporary = `${DATA_FILE}.upgrade.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(parsed, null, 2), "utf8");
      fs.renameSync(temporary, DATA_FILE);
    }
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Starting with a new database:", error.message);
    return emptyDatabase();
  }
}

let database = loadDatabase();

function saveDatabase() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temporary = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(database, null, 2), "utf8");
  fs.renameSync(temporary, DATA_FILE);
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function validUsername(value) {
  return /^[a-z0-9_-]{2,20}$/i.test(value);
}

function cleanMessage(value) {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r?\n/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, MAX_MESSAGE_LENGTH).join("");
}

function escapeHTML(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hashPasscode(passcode, salt) {
  return crypto.scryptSync(String(passcode), salt, 32).toString("hex");
}

function passcodeMatches(passcode, user) {
  const expected = Buffer.from(user.hash, "hex");
  const actual = Buffer.from(hashPasscode(passcode, user.salt), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function makeFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

function sendText(socket, text) {
  if (!socket.destroyed && socket.writable) socket.write(makeFrame(text));
}

function closeSocket(socket, code = 1000, reason = "") {
  if (socket.destroyed) return;
  const reasonBuffer = Buffer.from(String(reason).slice(0, 100), "utf8");
  const body = Buffer.alloc(2 + reasonBuffer.length);
  body.writeUInt16BE(code, 0);
  reasonBuffer.copy(body, 2);
  socket.write(makeFrame(body, 0x8));
  socket.end();
}

const clients = new Map();
const onlineUsers = new Map();
const calls = new Map();
const callTokens = new Map();
const callSockets = new Map();
const callLaunches = new Map();
const mediaTokens = new Map();

function sendToOnlineUser(userKey, text) {
  const sockets = onlineUsers.get(userKey);
  if (!sockets) return false;
  for (const socket of sockets) sendText(socket, text);
  return sockets.size > 0;
}

function authenticateCredentials(display, passcode) {
  const userKey = normalizeUsername(display);
  if (!validUsername(display)) return { error: "Enter a valid username." };
  const user = database.users[userKey];
  if (!user || !passcodeMatches(passcode, user)) return { error: "Incorrect username or passcode." };
  return { userKey, user };
}

function sendJson(response, statusCode, payload, headers = {}) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        reject(new Error("Request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Invalid request."));
      }
    });
    request.on("error", reject);
  });
}

function readRawBody(request, maximumBytes = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(new Error("The file is larger than 15 MB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function safeFileName(value) {
  let decoded = String(value || "file");
  try { decoded = decodeURIComponent(decoded); } catch {}
  return decoded.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 100) || "file";
}

function allowedMediaType(value) {
  const mime = String(value || "application/octet-stream").split(";")[0].trim().toLowerCase();
  if (mime === "image/svg+xml" || mime === "application/javascript") return null;
  if (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")) return mime;
  const allowed = new Set([
    "application/pdf", "application/zip", "application/x-7z-compressed", "application/x-rar-compressed",
    "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain", "text/html", "text/csv", "application/json", "application/octet-stream"
  ]);
  return allowed.has(mime) ? mime : null;
}

function mediaKind(mime) {
  if (mime === "text/html") return "HTML";
  if (mime === "image/gif") return "GIF";
  if (mime.startsWith("image/")) return "PHOTO";
  if (mime.startsWith("audio/")) return "VOICE";
  if (mime.startsWith("video/")) return "VIDEO";
  return "FILE";
}

function receiptLabel(message) {
  if (message.readAt) return "✓✓ read";
  if (message.deliveredAt) return "✓ delivered";
  return "✓ saved";
}

function storeAndDeliverMessage(senderKey, targetKey, messageText, attachment = null, senderSocket = null, extra = {}) {
  const now = new Date().toISOString();
  const recipients = onlineUsers.get(targetKey);
  const message = {
    id: crypto.randomUUID(),
    from: senderKey,
    to: targetKey,
    text: cleanMessage(messageText),
    sentAt: now,
    ...(recipients && recipients.size > 0 ? { deliveredAt: now } : {}),
    ...(attachment ? { attachment } : {}),
    ...extra,
  };
  database.messages.push(message);
  if (database.messages.length > 5000) database.messages = database.messages.slice(-5000);
  const recipientContacts = contactsFor(targetKey);
  let senderWasAutoSaved = false;
  if (!recipientContacts.includes(senderKey) && recipientContacts.length < 100) {
    recipientContacts.push(senderKey);
    senderWasAutoSaved = true;
  }
  saveDatabase();

  const senderName = database.users[senderKey].display;
  const targetName = database.users[targetKey].display;
  const senderLine = `You -> ${targetName}: ${message.text} ${receiptLabel(message)}`;
  if (senderSocket) sendText(senderSocket, senderLine);
  else sendToOnlineUser(senderKey, senderLine);
  if (recipients) {
    for (const recipientSocket of recipients) {
      sendText(recipientSocket, `[NEW MESSAGE] ${senderName}: ${message.text}`);
      if (senderWasAutoSaved) sendText(recipientSocket, `SYSTEM: ${senderName} was automatically saved to your contacts.`);
    }
  } else if (senderSocket) {
    sendText(senderSocket, `SYSTEM: ${targetName} is offline; the message was saved.`);
  }
  return message;
}

function markConversationRead(readerKey, senderKey) {
  const unread = database.messages.filter((message) => message.from === senderKey && message.to === readerKey && !message.readAt);
  if (unread.length === 0) return 0;
  const readAt = new Date().toISOString();
  for (const message of unread) {
    if (!message.deliveredAt) message.deliveredAt = readAt;
    message.readAt = readAt;
  }
  saveDatabase();
  const readerName = database.users[readerKey]?.display || readerKey;
  sendToOnlineUser(senderKey, `[READ ✓✓] ${readerName} read ${unread.length} message(s).`);
  return unread.length;
}

function validGroupId(value) {
  return /^[a-f0-9]{8}$/i.test(String(value || "").trim());
}

function groupsFor(userKey) {
  return Object.values(database.groups || {}).filter((group) => Array.isArray(group.members) && group.members.includes(userKey));
}

function groupForMember(groupId, userKey) {
  const group = database.groups[String(groupId || "").trim().toLowerCase()];
  return group && Array.isArray(group.members) && group.members.includes(userKey) ? group : null;
}

function groupReceiptLabel(message, group) {
  const recipients = Array.isArray(message.recipients)
    ? message.recipients
    : (group?.members || []).filter((memberKey) => memberKey !== message.from);
  if (recipients.length > 0 && recipients.every((memberKey) => message.readBy?.[memberKey])) return "✓✓ read";
  if (recipients.length > 0 && recipients.every((memberKey) => message.deliveredTo?.[memberKey])) return "✓ delivered";
  return "✓ saved";
}

function markGroupRead(readerKey, groupId) {
  const group = groupForMember(groupId, readerKey);
  if (!group) return 0;
  const unread = database.groupMessages.filter(
    (message) => message.groupId === group.id && message.from !== readerKey && message.recipients?.includes(readerKey) && !message.readBy?.[readerKey]
  );
  if (unread.length === 0) return 0;
  const readAt = new Date().toISOString();
  const senders = new Map();
  for (const message of unread) {
    if (!message.deliveredTo || typeof message.deliveredTo !== "object") message.deliveredTo = {};
    if (!message.readBy || typeof message.readBy !== "object") message.readBy = {};
    message.deliveredTo[readerKey] = message.deliveredTo[readerKey] || readAt;
    message.readBy[readerKey] = readAt;
    senders.set(message.from, (senders.get(message.from) || 0) + 1);
  }
  saveDatabase();
  const readerName = database.users[readerKey]?.display || readerKey;
  for (const [senderKey, count] of senders.entries()) {
    sendToOnlineUser(senderKey, `[GROUP READ ✓✓] ${readerName} read ${count} message(s) in ${group.name}.`);
  }
  return unread.length;
}

function storeAndDeliverGroupMessage(senderKey, group, messageText, senderSocket = null, attachment = null, extra = {}) {
  const now = new Date().toISOString();
  const recipients = group.members.filter((memberKey) => memberKey !== senderKey);
  const deliveredTo = {};
  for (const memberKey of recipients) {
    if (onlineUsers.has(memberKey)) deliveredTo[memberKey] = now;
  }
  const message = {
    id: crypto.randomUUID(),
    groupId: group.id,
    from: senderKey,
    text: cleanMessage(messageText),
    sentAt: now,
    recipients,
    deliveredTo,
    readBy: {},
    ...(attachment ? { attachment } : {}),
    ...extra,
  };
  database.groupMessages.push(message);
  if (database.groupMessages.length > 5000) database.groupMessages = database.groupMessages.slice(-5000);
  saveDatabase();

  const senderName = database.users[senderKey]?.display || senderKey;
  const senderLine = `You -> ${group.name} (#${group.id}): ${message.text} ${groupReceiptLabel(message, group)}`;
  if (senderSocket) sendText(senderSocket, senderLine);
  else sendToOnlineUser(senderKey, senderLine);
  const offline = [];
  for (const memberKey of recipients) {
    if (onlineUsers.has(memberKey)) {
      sendToOnlineUser(memberKey, `[NEW GROUP MESSAGE] ${group.name} · ${senderName}: ${message.text}`);
    } else {
      offline.push(database.users[memberKey]?.display || memberKey);
    }
  }
  if (offline.length > 0 && senderSocket) {
    sendText(senderSocket, `SYSTEM: Saved for offline group member(s): ${offline.join(", ")}.`);
  }
  return message;
}

function createCallToken(callId, userKey) {
  const token = crypto.randomBytes(32).toString("base64url");
  callTokens.set(token, { callId, userKey, expiresAt: Date.now() + 15 * 60 * 1000 });
  return token;
}

function callLabel(call) {
  if (call.groupId) return database.groups[call.groupId]?.name || call.groupName || `Group #${call.groupId}`;
  return database.users[call.target]?.display || call.target;
}

function acceptedCallUsers(call) {
  return [call.caller, ...Object.entries(call.decisions || {}).filter(([, decision]) => decision === "accepted").map(([userKey]) => userKey)];
}

function pendingCallUsers(call) {
  return Object.entries(call.decisions || {}).filter(([, decision]) => decision === "ringing").map(([userKey]) => userKey);
}

function notifyCallPlatform(callId, payload) {
  const participants = callSockets.get(callId);
  if (!participants) return;
  const outgoing = JSON.stringify(payload);
  for (const socket of participants.values()) sendText(socket, outgoing);
}

async function handleCallApi(request, response, requestPath) {
  try {
    const body = await readJsonBody(request);
    const launchKey = String(body.launchKey || "").trim();
    const validLaunchKey = /^[a-z0-9_-]{16,100}$/i.test(launchKey);
    const finish = (statusCode, payload) => {
      if (validLaunchKey) callLaunches.set(launchKey, { ...payload, statusCode, expiresAt: Date.now() + 2 * 60 * 1000 });
      return sendJson(response, statusCode, payload);
    };
    const auth = authenticateCredentials(String(body.username || "").trim(), String(body.passcode || ""));
    if (auth.error) return finish(401, { ok: false, error: auth.error });

    if (requestPath === "/api/call/start") {
      const targetName = String(body.target || "").trim();
      const mode = String(body.mode || "voice").toLowerCase() === "video" ? "video" : "voice";
      if (!validLaunchKey) return finish(400, { ok: false, error: "The call platform could not be opened." });
      const callId = crypto.randomUUID();
      let call;
      if (/^GROUP:/i.test(targetName)) {
        const groupId = targetName.slice("GROUP:".length).trim().toLowerCase();
        const group = groupForMember(groupId, auth.userKey);
        if (!validGroupId(groupId) || !group) return finish(404, { ok: false, error: "That group was not found in your groups." });
        const invitees = group.members.filter((memberKey) => memberKey !== auth.userKey && onlineUsers.has(memberKey));
        if (invitees.length === 0) return finish(409, { ok: false, error: `No other members of ${group.name} are online.` });
        call = {
          id: callId,
          caller: auth.userKey,
          groupId,
          groupName: group.name,
          mode,
          status: "ringing",
          decisions: Object.fromEntries(invitees.map((memberKey) => [memberKey, "ringing"])),
          createdAt: Date.now(),
        };
      } else {
        const targetKey = normalizeUsername(targetName);
        const target = database.users[targetKey];
        if (!target) return finish(404, { ok: false, error: `${targetName} has not registered.` });
        if (targetKey === auth.userKey) return finish(400, { ok: false, error: "You cannot call yourself." });
        if (!onlineUsers.has(targetKey)) return finish(409, { ok: false, error: `${target.display} is offline.` });
        call = {
          id: callId,
          caller: auth.userKey,
          target: targetKey,
          mode,
          status: "ringing",
          decisions: { [targetKey]: "ringing" },
          createdAt: Date.now(),
        };
      }
      calls.set(callId, call);
      const token = createCallToken(callId, auth.userKey);
      const label = callLabel(call);
      for (const inviteeKey of Object.keys(call.decisions)) {
        const callerLabel = call.groupId ? `${auth.user.display} · ${label}` : auth.user.display;
        sendToOnlineUser(inviteeKey, `[INCOMING CALL]|${callId}|${callerLabel}|${mode}`);
      }
      sendToOnlineUser(auth.userKey, `[CALLING] ${label} by ${mode}; each person can answer or decline.`);
      return finish(200, { ok: true, callId, group: Boolean(call.groupId), invited: Object.keys(call.decisions).length, path: `/call.html#token=${token}` });
    }

    const callId = String(body.callId || "").trim();
    const call = calls.get(callId);
    if (!call || call.status === "ended" || call.status === "rejected") {
      return finish(404, { ok: false, error: "This call is no longer available." });
    }
    if (!Object.prototype.hasOwnProperty.call(call.decisions || {}, auth.userKey)) {
      return finish(403, { ok: false, error: "This call invitation belongs to another account." });
    }

    if (requestPath === "/api/call/answer") {
      if (call.decisions[auth.userKey] === "rejected") return finish(409, { ok: false, error: "You already declined this call." });
      call.decisions[auth.userKey] = "accepted";
      call.status = "active";
      const token = createCallToken(callId, auth.userKey);
      const label = callLabel(call);
      sendToOnlineUser(call.caller, `[CALL ACCEPTED] ${auth.user.display} joined ${label}.`);
      for (const userKey of acceptedCallUsers(call)) {
        if (userKey !== call.caller && userKey !== auth.userKey) sendToOnlineUser(userKey, `[CALL UPDATE] ${auth.user.display} joined ${label}.`);
      }
      notifyCallPlatform(call.id, { type: "participant-accepted", userKey: auth.userKey, display: auth.user.display });
      if (!validLaunchKey) return finish(400, { ok: false, error: "The call platform could not be opened." });
      return finish(200, { ok: true, group: Boolean(call.groupId), path: `/call.html#token=${token}` });
    }

    if (requestPath === "/api/call/reject") {
      if (call.decisions[auth.userKey] === "accepted") return finish(409, { ok: false, error: "You already joined this call. End it from the call platform." });
      call.decisions[auth.userKey] = "rejected";
      const callerName = database.users[call.caller]?.display || call.caller;
      const label = callLabel(call);
      sendToOnlineUser(call.caller, `[CALL REJECTED] ${auth.user.display} declined ${label}.`);
      sendToOnlineUser(auth.userKey, `[CALL REJECTED] You declined the call from ${callerName}.`);
      notifyCallPlatform(call.id, { type: "participant-declined", userKey: auth.userKey, display: auth.user.display });
      const acceptedInvitees = acceptedCallUsers(call).filter((userKey) => userKey !== call.caller);
      const pendingInvitees = pendingCallUsers(call);
      if (acceptedInvitees.length === 0 && pendingInvitees.length === 0) {
        call.status = "rejected";
        sendToOnlineUser(call.caller, `[CALL ENDED] Everyone declined ${label}.`);
        notifyCallPlatform(call.id, { type: "call-ended", reason: `Everyone declined ${label}.` });
      } else if (acceptedInvitees.length > 0) {
        call.status = "active";
      }
      return finish(200, { ok: true, callEnded: call.status === "rejected", accepted: acceptedInvitees.length, pending: pendingInvitees.length });
    }

    return finish(404, { ok: false, error: "Unknown call action." });
  } catch (error) {
    if (!response.headersSent) sendJson(response, 400, { ok: false, error: error.message || "Call request failed." });
  }
}

function mediaSession(token) {
  const session = mediaTokens.get(String(token || ""));
  if (!session || session.expiresAt < Date.now()) {
    if (session) mediaTokens.delete(String(token || ""));
    return null;
  }
  return session;
}

async function handleMediaStart(request, response) {
  try {
    const body = await readJsonBody(request);
    const auth = authenticateCredentials(String(body.username || "").trim(), String(body.passcode || ""));
    if (auth.error) return sendJson(response, 401, { ok: false, error: auth.error });
    const targetName = String(body.target || "").trim();
    const token = crypto.randomBytes(32).toString("base64url");
    if (/^GROUP:/i.test(targetName)) {
      const groupId = targetName.slice("GROUP:".length).trim().toLowerCase();
      const group = groupForMember(groupId, auth.userKey);
      if (!validGroupId(groupId) || !group) return sendJson(response, 404, { ok: false, error: "That group was not found in your groups." });
      mediaTokens.set(token, { userKey: auth.userKey, groupId, expiresAt: Date.now() + 30 * 60 * 1000 });
      return sendJson(response, 200, { ok: true, group: true, path: `/media.html#token=${token}` });
    }
    const targetKey = normalizeUsername(targetName);
    const target = database.users[targetKey];
    if (!target || !validUsername(targetName)) return sendJson(response, 404, { ok: false, error: `${targetName || "That contact"} has not registered.` });
    if (targetKey === auth.userKey) return sendJson(response, 400, { ok: false, error: "You cannot send media to yourself." });
    mediaTokens.set(token, { userKey: auth.userKey, targetKey, expiresAt: Date.now() + 30 * 60 * 1000 });
    sendJson(response, 200, { ok: true, group: false, path: `/media.html#token=${token}` });
  } catch (error) {
    if (!response.headersSent) sendJson(response, 400, { ok: false, error: error.message || "The media studio could not open." });
  }
}

function messagesForMediaSession(session) {
  if (session.groupId) {
    const group = groupForMember(session.groupId, session.userKey);
    if (!group) return [];
    const memberSince = group.joinedAt?.[session.userKey] || group.createdAt || "";
    return database.groupMessages.filter(
      (message) => message.groupId === group.id && (!memberSince || message.sentAt >= memberSince)
    );
  }
  return database.messages.filter((message) => sameConversation(message, session));
}

function mediaReceiptLabel(message, session) {
  return session.groupId ? groupReceiptLabel(message, database.groups[session.groupId]) : receiptLabel(message);
}

function storeMediaSessionMessage(session, text, attachment = null, extra = {}) {
  if (session.groupId) {
    const group = groupForMember(session.groupId, session.userKey);
    if (!group) throw new Error("You are no longer in this group.");
    return storeAndDeliverGroupMessage(session.userKey, group, text, null, attachment, extra);
  }
  return storeAndDeliverMessage(session.userKey, session.targetKey, text, attachment, null, extra);
}

function mediaSessionPayload(session, pageOrigin) {
  if (session.groupId) markGroupRead(session.userKey, session.groupId);
  else markConversationRead(session.userKey, session.targetKey);
  const conversation = messagesForMediaSession(session);
  const group = session.groupId ? groupForMember(session.groupId, session.userKey) : null;
  const items = conversation
    .filter((message) => message.attachment)
    .slice(-30)
    .reverse()
    .map((message) => ({
      id: message.attachment.id,
      name: message.attachment.name,
      mime: message.attachment.mime,
      size: message.attachment.size,
      kind: message.attachment.kind,
      from: database.users[message.from]?.display || message.from,
      status: mediaReceiptLabel(message, session),
      url: `${pageOrigin}/media/${message.attachment.id}`,
    }));
  const sharedContacts = conversation
    .filter((message) => message.sharedContact)
    .slice(-20)
    .reverse()
    .map((message) => ({
      username: message.sharedContact.userKey,
      display: message.sharedContact.display,
      from: database.users[message.from]?.display || message.from,
      saved: contactsFor(session.userKey).includes(message.sharedContact.userKey),
      canSave: message.sharedContact.userKey !== session.userKey,
      status: mediaReceiptLabel(message, session),
    }));
  const polls = conversation
    .filter((message) => message.poll)
    .slice(-20)
    .reverse()
    .map((message) => pollPayload(message, session.userKey, session));
  return {
    ok: true,
    user: database.users[session.userKey]?.display || session.userKey,
    target: group?.name || database.users[session.targetKey]?.display || session.targetKey,
    isGroup: Boolean(group),
    groupId: group?.id || null,
    memberCount: group?.members.length || 2,
    items,
    sharedContacts,
    polls,
  };
}

async function handleMediaUpload(request, response, session, pageOrigin) {
  try {
    let mime = allowedMediaType(request.headers["content-type"]);
    if (!mime) return sendJson(response, 415, { ok: false, error: "This file type is not supported." });
    const body = await readRawBody(request);
    if (body.length === 0) return sendJson(response, 400, { ok: false, error: "The selected file is empty." });
    const name = safeFileName(request.headers["x-file-name"] || "file");
    const extensionMatch = /\.([a-z0-9]{1,10})$/i.exec(name);
    const extension = extensionMatch ? `.${extensionMatch[1].toLowerCase()}` : "";
    if ([".html", ".htm"].includes(extension) && ["application/octet-stream", "text/plain", "text/html"].includes(mime)) mime = "text/html";
    const id = crypto.randomBytes(18).toString("hex");
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, `${id}${extension}`), body);
    const kind = mediaKind(mime);
    const attachment = { id, name, mime, size: body.length, kind, extension };
    const messageText = `[${kind}] ${name} — ${pageOrigin}/media/${id}`;
    const message = storeMediaSessionMessage(session, messageText, attachment);
    sendJson(response, 200, { ok: true, kind, status: mediaReceiptLabel(message, session), id, url: `${pageOrigin}/media/${id}` });
  } catch (error) {
    if (!response.headersSent) sendJson(response, 400, { ok: false, error: error.message || "The file could not be sent." });
  }
}

function cleanShortText(value, maximum = 120) {
  return Array.from(String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, maximum).join("");
}

function sameConversation(message, session) {
  if (session.groupId) return message.groupId === session.groupId;
  return (message.from === session.userKey && message.to === session.targetKey) ||
    (message.from === session.targetKey && message.to === session.userKey);
}

async function handleShareContact(request, response, session) {
  try {
    const body = await readJsonBody(request);
    const requested = cleanShortText(body.username, 20);
    const contactKey = normalizeUsername(requested);
    const contact = database.users[contactKey];
    if (!validUsername(requested) || !contact) return sendJson(response, 404, { ok: false, error: "That contact has not registered." });
    const mayShare = contactKey === session.userKey || contactsFor(session.userKey).includes(contactKey);
    if (!mayShare) return sendJson(response, 403, { ok: false, error: "Save this username to your contacts before sharing it." });
    const sharedContact = { userKey: contactKey, display: contact.display };
    const message = storeMediaSessionMessage(
      session,
      `[CONTACT] ${contact.display} (@${contactKey}) — Open MEDIA to save this contact.`,
      null,
      { sharedContact }
    );
    sendJson(response, 200, { ok: true, contact: sharedContact, status: mediaReceiptLabel(message, session) });
  } catch (error) {
    if (!response.headersSent) sendJson(response, 400, { ok: false, error: error.message || "The contact could not be shared." });
  }
}

async function handleSaveSharedContact(request, response, session) {
  try {
    const body = await readJsonBody(request);
    const contactKey = normalizeUsername(body.username);
    const contact = database.users[contactKey];
    const wasShared = messagesForMediaSession(session).some((message) => message.sharedContact?.userKey === contactKey);
    if (!contact || !wasShared) return sendJson(response, 404, { ok: false, error: "That shared contact is no longer available." });
    if (contactKey === session.userKey) return sendJson(response, 400, { ok: false, error: "This is your own account." });
    const contacts = contactsFor(session.userKey);
    if (!contacts.includes(contactKey)) {
      if (contacts.length >= 100) return sendJson(response, 409, { ok: false, error: "Your contact list is full." });
      contacts.push(contactKey);
      saveDatabase();
    }
    sendJson(response, 200, { ok: true, display: contact.display, saved: true });
  } catch (error) {
    if (!response.headersSent) sendJson(response, 400, { ok: false, error: error.message || "The contact could not be saved." });
  }
}

function pollPayload(message, viewerKey, session = null) {
  return {
    id: message.poll.id,
    question: message.poll.question,
    from: database.users[message.from]?.display || message.from,
    status: session ? mediaReceiptLabel(message, session) : receiptLabel(message),
    options: message.poll.options.map((option) => ({
      id: option.id,
      text: option.text,
      votes: option.votes.length,
      selected: option.votes.includes(viewerKey),
    })),
  };
}

async function handleCreatePoll(request, response, session) {
  try {
    const body = await readJsonBody(request);
    const question = cleanShortText(body.question, 120);
    const options = [...new Set((Array.isArray(body.options) ? body.options : []).map((value) => cleanShortText(value, 60)).filter(Boolean))].slice(0, 4);
    if (!question) return sendJson(response, 400, { ok: false, error: "Type a poll question." });
    if (options.length < 2) return sendJson(response, 400, { ok: false, error: "Add at least two different poll choices." });
    const poll = {
      id: crypto.randomUUID(),
      question,
      options: options.map((text, index) => ({ id: `option-${index + 1}`, text, votes: [] })),
    };
    const message = storeMediaSessionMessage(
      session,
      `[POLL] ${question} — Open MEDIA to vote.`,
      null,
      { poll }
    );
    sendJson(response, 200, { ok: true, poll: pollPayload(message, session.userKey, session), status: mediaReceiptLabel(message, session) });
  } catch (error) {
    if (!response.headersSent) sendJson(response, 400, { ok: false, error: error.message || "The poll could not be created." });
  }
}

async function handlePollVote(request, response, session) {
  try {
    const body = await readJsonBody(request);
    const pollId = String(body.pollId || "");
    const optionId = String(body.optionId || "");
    const message = messagesForMediaSession(session).find((item) => item.poll?.id === pollId);
    if (!message) return sendJson(response, 404, { ok: false, error: "That poll is no longer available." });
    const option = message.poll.options.find((item) => item.id === optionId);
    if (!option) return sendJson(response, 400, { ok: false, error: "Choose a valid poll option." });
    for (const item of message.poll.options) item.votes = item.votes.filter((userKey) => userKey !== session.userKey);
    option.votes.push(session.userKey);
    saveDatabase();
    const voterName = database.users[session.userKey]?.display || session.userKey;
    const update = `[POLL UPDATE] ${voterName} voted on “${message.poll.question}”.`;
    if (session.groupId) {
      const group = groupForMember(session.groupId, session.userKey);
      for (const memberKey of group?.members || []) sendToOnlineUser(memberKey, update);
    } else {
      sendToOnlineUser(message.from, update);
      sendToOnlineUser(message.to, update);
    }
    sendJson(response, 200, { ok: true, poll: pollPayload(message, session.userKey, session) });
  } catch (error) {
    if (!response.headersSent) sendJson(response, 400, { ok: false, error: error.message || "Your vote could not be saved." });
  }
}

function addOnline(userKey, socket) {
  if (!onlineUsers.has(userKey)) onlineUsers.set(userKey, new Set());
  onlineUsers.get(userKey).add(socket);
}

function removeOnline(state, socket) {
  if (!state.userKey) return;
  const sockets = onlineUsers.get(state.userKey);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) onlineUsers.delete(state.userKey);
}

function sendHistory(socket, userKey) {
  const relevant = database.messages
    .filter((message) => message.from === userKey || message.to === userKey)
    .slice(-HISTORY_LIMIT);
  if (relevant.length === 0) {
    sendText(socket, "SYSTEM: No saved messages yet.");
    return;
  }
  sendText(socket, `SYSTEM: Loading ${relevant.length} saved message(s).`);
  for (const message of relevant) {
    if (message.from === userKey) {
      const target = database.users[message.to]?.display || message.to;
      sendText(socket, `HISTORY You -> ${target}: ${message.text} ${receiptLabel(message)}`);
    } else {
      const sender = database.users[message.from]?.display || message.from;
      sendText(socket, `HISTORY ${sender}: ${message.text}`);
    }
  }
}

function sendMissedMessages(socket, userKey) {
  const missed = database.messages.filter(
    (message) => message.to === userKey && !message.deliveredAt
  );
  const missedGroups = database.groupMessages.filter(
    (message) => message.from !== userKey && message.recipients?.includes(userKey) && !message.deliveredTo?.[userKey]
  );
  if (missed.length === 0 && missedGroups.length === 0) {
    sendText(socket, "[MISSED MESSAGES] No new messages while you were signed out.");
    return;
  }

  const deliveredAt = new Date().toISOString();
  const directSenders = new Map();
  if (missed.length > 0) {
    const counts = new Map();
    const latest = new Map();
    for (const message of missed) {
      counts.set(message.from, (counts.get(message.from) || 0) + 1);
      latest.set(message.from, message);
      directSenders.set(message.from, true);
      message.deliveredAt = deliveredAt;
    }
    const senderSummary = [...counts.entries()]
      .map(([senderKey, count]) => `${database.users[senderKey]?.display || senderKey} (${count})`)
      .join(", ");
    sendText(socket, `[MISSED MESSAGES] ${missed.length} new message(s) from ${senderSummary}.`);
    for (const [senderKey, message] of latest.entries()) {
      const sender = database.users[senderKey]?.display || senderKey;
      sendText(socket, `[MISSED FROM] ${sender}: ${message.text}`);
    }
  }

  const groupSenders = new Map();
  if (missedGroups.length > 0) {
    const counts = new Map();
    const latest = new Map();
    for (const message of missedGroups) {
      if (!message.deliveredTo || typeof message.deliveredTo !== "object") message.deliveredTo = {};
      message.deliveredTo[userKey] = deliveredAt;
      counts.set(message.groupId, (counts.get(message.groupId) || 0) + 1);
      latest.set(message.groupId, message);
      groupSenders.set(message.from, (groupSenders.get(message.from) || 0) + 1);
    }
    const groupSummary = [...counts.entries()]
      .map(([groupId, count]) => `${database.groups[groupId]?.name || `#${groupId}`} (${count})`)
      .join(", ");
    sendText(socket, `[MISSED GROUPS] ${missedGroups.length} new group message(s) in ${groupSummary}.`);
    for (const [groupId, message] of latest.entries()) {
      const groupName = database.groups[groupId]?.name || `#${groupId}`;
      const senderName = database.users[message.from]?.display || message.from;
      sendText(socket, `[MISSED GROUP] ${groupName} · ${senderName}: ${message.text}`);
    }
  }
  saveDatabase();
  for (const senderKey of directSenders.keys()) {
    sendToOnlineUser(senderKey, `[DELIVERED ✓] ${database.users[userKey]?.display || userKey} received your saved message(s).`);
  }
  for (const [senderKey, count] of groupSenders.entries()) {
    sendToOnlineUser(senderKey, `[GROUP DELIVERED ✓] ${database.users[userKey]?.display || userKey} received ${count} saved group message(s).`);
  }
}

function rateLimitAllows(state) {
  const now = Date.now();
  state.sentTimes = state.sentTimes.filter((time) => now - time < 10_000);
  if (state.sentTimes.length >= 8) return false;
  state.sentTimes.push(now);
  return true;
}

function requireSignedIn(state, socket) {
  if (state.userKey) return true;
  sendText(socket, "SYSTEM: Sign in before using contacts, groups, or sending messages.");
  return false;
}

function handleAuth(socket, state, pieces, mode = "AUTO") {
  const display = String(pieces.shift() || "").trim();
  const passcode = pieces.join("|");
  const userKey = normalizeUsername(display);
  if (!validUsername(display)) {
    sendText(socket, "[ACCOUNT ERROR] Username must be 2-20 letters, numbers, - or _.");
    return;
  }
  if (passcode.length < 4 || passcode.length > 64) {
    sendText(socket, "[ACCOUNT ERROR] Passcode must be 4-64 characters.");
    return;
  }

  const existing = database.users[userKey];
  if (mode === "LOGIN" && !existing) {
    sendText(socket, `[ACCOUNT ERROR] ${display} does not exist. Use REGISTER first.`);
    return;
  }
  if (mode === "REGISTER" && existing) {
    sendText(socket, `[ACCOUNT ERROR] ${existing.display} already exists. Use LOGIN.`);
    return;
  }
  if (existing && !passcodeMatches(passcode, existing)) {
    sendText(socket, "[ACCOUNT ERROR] Incorrect passcode for that username.");
    return;
  }

  removeOnline(state, socket);
  if (!existing) {
    const salt = crypto.randomBytes(16).toString("hex");
    database.users[userKey] = {
      display,
      salt,
      hash: hashPasscode(passcode, salt),
      contacts: [],
      createdAt: new Date().toISOString(),
    };
    saveDatabase();
    sendText(socket, `[ACCOUNT OK] Account created as ${display}.`);
  } else {
    if (!Array.isArray(existing.contacts)) {
      existing.contacts = [];
      saveDatabase();
    }
    sendText(socket, `[ACCOUNT OK] Signed in as ${existing.display}.`);
  }

  state.userKey = userKey;
  addOnline(userKey, socket);
  sendMissedMessages(socket, userKey);
  sendHistory(socket, userKey);
  const joinedGroups = groupsFor(userKey);
  if (joinedGroups.length > 0) {
    sendText(socket, `SYSTEM: You are in ${joinedGroups.length} group(s). Choose MY GROUPS to open them.`);
  }
}

function handleCheck(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  const requested = String(pieces.shift() || "").trim();
  const targetKey = normalizeUsername(requested);
  if (!validUsername(requested)) {
    sendText(socket, "SYSTEM: Enter a valid contact username.");
    return;
  }
  const account = database.users[targetKey];
  if (!account) {
    sendText(socket, `SYSTEM: ${requested} has not created an account yet.`);
    return;
  }
  const status = onlineUsers.has(targetKey) ? "online" : "offline";
  sendText(socket, `SYSTEM: ${account.display} is ${status}.`);
}

function contactsFor(userKey) {
  const user = database.users[userKey];
  if (!Array.isArray(user.contacts)) user.contacts = [];
  return user.contacts;
}

function handleContacts(socket, state) {
  if (!requireSignedIn(state, socket)) return;
  const contacts = contactsFor(state.userKey).filter((key) => database.users[key]);
  if (contacts.length === 0) {
    sendText(socket, "SYSTEM: You have no saved contacts yet.");
    return;
  }
  const names = contacts.map((key) => database.users[key].display);
  sendText(socket, `SYSTEM: Saved contacts: ${names.join(", ")}`);
}

function handleSaveContact(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  const requested = String(pieces.shift() || "").trim();
  const targetKey = normalizeUsername(requested);
  if (!validUsername(requested)) {
    sendText(socket, "SYSTEM: Enter a valid contact username.");
    return;
  }
  const target = database.users[targetKey];
  if (!target) {
    sendText(socket, `SYSTEM: ${requested} has not created an account yet.`);
    return;
  }
  if (targetKey === state.userKey) {
    sendText(socket, "SYSTEM: You cannot save your own account as a contact.");
    return;
  }
  const contacts = contactsFor(state.userKey);
  if (contacts.includes(targetKey)) {
    sendText(socket, `SYSTEM: ${target.display} is already saved.`);
    return;
  }
  if (contacts.length >= 100) {
    sendText(socket, "SYSTEM: Contact limit reached. Delete one before adding another.");
    return;
  }
  contacts.push(targetKey);
  saveDatabase();
  sendText(socket, `SYSTEM: Saved ${target.display} to your contacts.`);
}

function handleDeleteContact(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  const requested = String(pieces.shift() || "").trim();
  const targetKey = normalizeUsername(requested);
  const contacts = contactsFor(state.userKey);
  const index = contacts.indexOf(targetKey);
  if (index === -1) {
    sendText(socket, `SYSTEM: ${requested || "That username"} is not in your saved contacts.`);
    return;
  }
  const display = database.users[targetKey]?.display || requested || targetKey;
  contacts.splice(index, 1);
  saveDatabase();
  sendText(socket, `SYSTEM: Removed ${display} from your contacts.`);
}

function handleHistory(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  const requested = String(pieces.shift() || "").trim();
  const targetKey = normalizeUsername(requested);
  if (!validUsername(requested)) {
    sendText(socket, "SYSTEM: Enter a valid contact username.");
    return;
  }
  const target = database.users[targetKey];
  if (!target) {
    sendText(socket, `SYSTEM: ${requested} has not created an account yet.`);
    return;
  }
  markConversationRead(state.userKey, targetKey);
  const relevant = database.messages
    .filter(
      (message) =>
        (message.from === state.userKey && message.to === targetKey) ||
        (message.from === targetKey && message.to === state.userKey)
    )
    .slice(-HISTORY_LIMIT);
  sendText(socket, `SYSTEM: Chat with ${target.display} - ${relevant.length} saved message(s).`);
  for (const message of relevant) {
    sendText(
      socket,
      message.from === state.userKey
        ? `You -> ${target.display}: ${message.text} ${receiptLabel(message)}`
        : `${target.display}: ${message.text}`
    );
  }
}

function handleSend(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  if (!rateLimitAllows(state)) {
    sendText(socket, "SYSTEM: Slow down for a few seconds before sending again.");
    return;
  }

  const requested = String(pieces.shift() || "").trim();
  const targetKey = normalizeUsername(requested);
  const messageText = cleanMessage(pieces.join("|"));
  if (!validUsername(requested)) {
    sendText(socket, "SYSTEM: Enter a valid contact username.");
    return;
  }
  const target = database.users[targetKey];
  if (!target) {
    sendText(socket, `SYSTEM: ${requested} has not created an account yet.`);
    return;
  }
  if (!messageText) {
    sendText(socket, "SYSTEM: Empty messages are not sent.");
    return;
  }

  storeAndDeliverMessage(state.userKey, targetKey, messageText, null, socket);
}

function handleGroups(socket, state) {
  if (!requireSignedIn(state, socket)) return;
  const groups = groupsFor(state.userKey).sort((a, b) => a.name.localeCompare(b.name));
  if (groups.length === 0) {
    sendText(socket, "SYSTEM: You are not in any groups yet. Choose CREATE GROUP on the home screen.");
    return;
  }
  sendText(socket, `SYSTEM: Your groups (${groups.length}):`);
  for (const group of groups) {
    const owner = database.users[group.owner]?.display || group.owner;
    sendText(socket, `GROUP: ${group.name} | code ${group.id} | ${group.members.length} members | owner ${owner}`);
  }
}

function handleGroupCreate(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  const groupName = cleanShortText(pieces.shift(), 40);
  const requestedMembers = [...new Set(
    pieces.join("|").split(/[\s,]+/).map(normalizeUsername).filter(Boolean)
  )];
  if (groupName.length < 2) {
    sendText(socket, "SYSTEM: A group name needs at least 2 characters.");
    return;
  }
  if (groupsFor(state.userKey).length >= GROUP_LIMIT_PER_USER) {
    sendText(socket, "SYSTEM: You have reached the 50-group limit.");
    return;
  }
  const invalid = requestedMembers.filter((memberKey) => !validUsername(memberKey) || !database.users[memberKey]);
  if (invalid.length > 0) {
    sendText(socket, `SYSTEM: These usernames have not registered: ${invalid.join(", ")}.`);
    return;
  }
  const fullMembers = requestedMembers.filter((memberKey) => groupsFor(memberKey).length >= GROUP_LIMIT_PER_USER);
  if (fullMembers.length > 0) {
    sendText(socket, `SYSTEM: These usernames have reached their group limit: ${fullMembers.join(", ")}.`);
    return;
  }
  const members = [state.userKey, ...requestedMembers.filter((memberKey) => memberKey !== state.userKey)];
  if (members.length < 2) {
    sendText(socket, "SYSTEM: Add at least one other registered username to the group.");
    return;
  }
  if (members.length > GROUP_MEMBER_LIMIT) {
    sendText(socket, `SYSTEM: A group can have at most ${GROUP_MEMBER_LIMIT} members.`);
    return;
  }
  let groupId;
  do groupId = crypto.randomBytes(4).toString("hex"); while (database.groups[groupId]);
  const group = {
    id: groupId,
    name: groupName,
    owner: state.userKey,
    members,
    createdAt: new Date().toISOString(),
  };
  group.joinedAt = Object.fromEntries(members.map((memberKey) => [memberKey, group.createdAt]));
  database.groups[groupId] = group;
  saveDatabase();
  const creator = database.users[state.userKey]?.display || state.userKey;
  sendText(socket, `SYSTEM: Created group ${group.name}. Its group code is ${group.id}.`);
  for (const memberKey of members) {
    if (memberKey !== state.userKey) {
      sendToOnlineUser(memberKey, `[GROUP ADDED] ${creator} added you to ${group.name} (#${group.id}). Open MY GROUPS to chat.`);
    }
  }
}

function handleGroupInfo(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  const groupId = String(pieces.shift() || "").trim().toLowerCase();
  const group = groupForMember(groupId, state.userKey);
  if (!validGroupId(groupId) || !group) {
    sendText(socket, "SYSTEM: That group code was not found in your groups.");
    return;
  }
  const memberNames = group.members.map((memberKey) => database.users[memberKey]?.display || memberKey);
  const owner = database.users[group.owner]?.display || group.owner;
  sendText(socket, `SYSTEM: ${group.name} (#${group.id}) · owner ${owner} · members: ${memberNames.join(", ")}`);
}

function handleGroupHistory(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  const groupId = String(pieces.shift() || "").trim().toLowerCase();
  const group = groupForMember(groupId, state.userKey);
  if (!validGroupId(groupId) || !group) {
    sendText(socket, "SYSTEM: That group code was not found in your groups.");
    return;
  }
  markGroupRead(state.userKey, group.id);
  const memberSince = group.joinedAt?.[state.userKey] || group.createdAt || "";
  const relevant = database.groupMessages
    .filter((message) => message.groupId === group.id && (!memberSince || message.sentAt >= memberSince))
    .slice(-HISTORY_LIMIT);
  sendText(socket, `SYSTEM: Group chat ${group.name} (#${group.id}) - ${relevant.length} saved message(s).`);
  for (const message of relevant) {
    const senderName = database.users[message.from]?.display || message.from;
    sendText(
      socket,
      message.from === state.userKey
        ? `You -> ${group.name}: ${message.text} ${groupReceiptLabel(message, group)}`
        : `${senderName}: ${message.text}`
    );
  }
}

function handleGroupSend(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  if (!rateLimitAllows(state)) {
    sendText(socket, "SYSTEM: Slow down for a few seconds before sending again.");
    return;
  }
  const groupId = String(pieces.shift() || "").trim().toLowerCase();
  const group = groupForMember(groupId, state.userKey);
  const messageText = cleanMessage(pieces.join("|"));
  if (!validGroupId(groupId) || !group) {
    sendText(socket, "SYSTEM: That group code was not found in your groups.");
    return;
  }
  if (!messageText) {
    sendText(socket, "SYSTEM: Empty messages are not sent.");
    return;
  }
  storeAndDeliverGroupMessage(state.userKey, group, messageText, socket);
}

function handleGroupAdd(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  const groupId = String(pieces.shift() || "").trim().toLowerCase();
  const requested = String(pieces.shift() || "").trim();
  const memberKey = normalizeUsername(requested);
  const group = groupForMember(groupId, state.userKey);
  if (!validGroupId(groupId) || !group) {
    sendText(socket, "SYSTEM: That group code was not found in your groups.");
    return;
  }
  if (group.owner !== state.userKey) {
    sendText(socket, "SYSTEM: Only the group owner can add members.");
    return;
  }
  if (!validUsername(requested) || !database.users[memberKey]) {
    sendText(socket, `SYSTEM: ${requested || "That username"} has not created an account yet.`);
    return;
  }
  if (group.members.includes(memberKey)) {
    sendText(socket, `SYSTEM: ${database.users[memberKey].display} is already in ${group.name}.`);
    return;
  }
  if (groupsFor(memberKey).length >= GROUP_LIMIT_PER_USER) {
    sendText(socket, `SYSTEM: ${database.users[memberKey].display} has reached the 50-group limit.`);
    return;
  }
  if (group.members.length >= GROUP_MEMBER_LIMIT) {
    sendText(socket, `SYSTEM: ${group.name} already has the maximum ${GROUP_MEMBER_LIMIT} members.`);
    return;
  }
  group.members.push(memberKey);
  if (!group.joinedAt || typeof group.joinedAt !== "object") group.joinedAt = {};
  group.joinedAt[memberKey] = new Date().toISOString();
  saveDatabase();
  const memberName = database.users[memberKey].display;
  sendText(socket, `SYSTEM: Added ${memberName} to ${group.name}.`);
  const ownerName = database.users[state.userKey]?.display || state.userKey;
  sendToOnlineUser(memberKey, `[GROUP ADDED] ${ownerName} added you to ${group.name} (#${group.id}). Open MY GROUPS to chat.`);
  for (const otherKey of group.members) {
    if (otherKey !== state.userKey && otherKey !== memberKey) {
      sendToOnlineUser(otherKey, `[GROUP UPDATE] ${memberName} joined ${group.name}.`);
    }
  }
}

function handleGroupLeave(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  const groupId = String(pieces.shift() || "").trim().toLowerCase();
  const group = groupForMember(groupId, state.userKey);
  if (!validGroupId(groupId) || !group) {
    sendText(socket, "SYSTEM: That group code was not found in your groups.");
    return;
  }
  if (group.owner === state.userKey) {
    sendText(socket, "SYSTEM: The group owner cannot leave. Use DELETE GROUP if you want to remove the group for everyone.");
    return;
  }
  group.members = group.members.filter((memberKey) => memberKey !== state.userKey);
  if (group.joinedAt && typeof group.joinedAt === "object") delete group.joinedAt[state.userKey];
  saveDatabase();
  const memberName = database.users[state.userKey]?.display || state.userKey;
  sendText(socket, `SYSTEM: You left ${group.name}.`);
  for (const memberKey of group.members) sendToOnlineUser(memberKey, `[GROUP UPDATE] ${memberName} left ${group.name}.`);
}

function handleGroupDelete(socket, state, pieces) {
  if (!requireSignedIn(state, socket)) return;
  const groupId = String(pieces.shift() || "").trim().toLowerCase();
  const group = groupForMember(groupId, state.userKey);
  if (!validGroupId(groupId) || !group) {
    sendText(socket, "SYSTEM: That group code was not found in your groups.");
    return;
  }
  if (group.owner !== state.userKey) {
    sendText(socket, "SYSTEM: Only the group owner can delete this group.");
    return;
  }
  const memberKeys = [...group.members];
  delete database.groups[group.id];
  database.groupMessages = database.groupMessages.filter((message) => message.groupId !== group.id);
  saveDatabase();
  sendText(socket, `SYSTEM: Deleted group ${group.name}.`);
  for (const memberKey of memberKeys) {
    if (memberKey !== state.userKey) sendToOnlineUser(memberKey, `[GROUP DELETED] ${group.name} was deleted by its owner.`);
  }
}

function handleText(socket, state, text) {
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
    closeSocket(socket, 1009, "Message too large");
    return;
  }
  const pieces = String(text).split("|");
  const command = String(pieces.shift() || "").toUpperCase();
  if (command === "AUTH") return handleAuth(socket, state, pieces, "AUTO");
  if (command === "LOGIN") return handleAuth(socket, state, pieces, "LOGIN");
  if (command === "REGISTER") return handleAuth(socket, state, pieces, "REGISTER");
  if (command === "CHECK") return handleCheck(socket, state, pieces);
  if (command === "CONTACTS") return handleContacts(socket, state);
  if (command === "SAVE_CONTACT") return handleSaveContact(socket, state, pieces);
  if (command === "DELETE_CONTACT") return handleDeleteContact(socket, state, pieces);
  if (command === "HISTORY") return handleHistory(socket, state, pieces);
  if (command === "SEND") return handleSend(socket, state, pieces);
  if (command === "GROUPS") return handleGroups(socket, state);
  if (command === "GROUP_CREATE") return handleGroupCreate(socket, state, pieces);
  if (command === "GROUP_INFO") return handleGroupInfo(socket, state, pieces);
  if (command === "GROUP_HISTORY") return handleGroupHistory(socket, state, pieces);
  if (command === "GROUP_SEND") return handleGroupSend(socket, state, pieces);
  if (command === "GROUP_ADD") return handleGroupAdd(socket, state, pieces);
  if (command === "GROUP_LEAVE") return handleGroupLeave(socket, state, pieces);
  if (command === "GROUP_DELETE") return handleGroupDelete(socket, state, pieces);
  if (command === "PING") return sendText(socket, "SYSTEM: Server is online.");
  sendText(socket, "SYSTEM: Unknown request.");
}

function callParticipantDisplay(userKey) {
  return database.users[userKey]?.display || userKey;
}

function endCallForEveryone(call, reason) {
  if (!call || call.status === "ended" || call.status === "rejected") return;
  call.status = "ended";
  notifyCallPlatform(call.id, { type: "call-ended", reason });
  const notified = new Set([call.caller, ...Object.keys(call.decisions || {})]);
  for (const userKey of notified) sendToOnlineUser(userKey, `[CALL ENDED] ${reason}`);
}

function removeCallSocket(state, socket, explicitHangup = false) {
  if (state.removed) return;
  const participants = callSockets.get(state.callId);
  if (!participants || participants.get(state.userKey) !== socket) return;
  state.removed = true;
  participants.delete(state.userKey);
  const call = calls.get(state.callId);
  const display = callParticipantDisplay(state.userKey);
  for (const peerSocket of participants.values()) {
    sendText(peerSocket, JSON.stringify({ type: "peer-left", userKey: state.userKey, display }));
  }
  if (participants.size === 0) callSockets.delete(state.callId);
  if (!call || !explicitHangup) return;

  if (!call.groupId) {
    const otherKey = state.userKey === call.caller ? call.target : call.caller;
    endCallForEveryone(call, `${display} ended the call with ${callParticipantDisplay(otherKey)}.`);
    return;
  }

  if (state.userKey !== call.caller && call.decisions?.[state.userKey] === "accepted") {
    call.decisions[state.userKey] = "left";
  }
  const pending = pendingCallUsers(call).length;
  const acceptedNotConnected = Object.entries(call.decisions || {}).filter(([userKey, decision]) => decision === "accepted" && !participants.has(userKey)).length;
  if (participants.size < 2 && pending === 0 && acceptedNotConnected === 0) {
    endCallForEveryone(call, `The ${callLabel(call)} group call ended.`);
  } else {
    for (const userKey of acceptedCallUsers(call)) {
      if (userKey !== state.userKey) sendToOnlineUser(userKey, `[CALL UPDATE] ${display} left ${callLabel(call)}.`);
    }
  }
}

function handleCallSignal(socket, state, text) {
  let message;
  try {
    message = JSON.parse(String(text));
  } catch {
    return sendText(socket, JSON.stringify({ type: "error", message: "Invalid call signal." }));
  }
  const allowed = new Set(["offer", "answer", "ice", "hangup", "screen-state", "relay-request", "relay-audio", "relay-video"]);
  if (!allowed.has(message.type)) return;
  const call = calls.get(state.callId);
  if (!call) return;

  const participants = callSockets.get(state.callId);
  if (!participants) return;

  if (["relay-request", "relay-audio", "relay-video"].includes(message.type)) {
    const now = Date.now();
    if (!state.relayWindowStart || now - state.relayWindowStart >= 1000) {
      state.relayWindowStart = now;
      state.relayMessages = 0;
    }
    state.relayMessages = Number(state.relayMessages || 0) + 1;
    if (state.relayMessages > 35) return;
    let outgoingMessage;
    if (message.type === "relay-request") {
      outgoingMessage = { type: "relay-request", from: state.userKey };
    } else if (message.type === "relay-audio") {
      if (typeof message.data !== "string" || message.data.length > 24000) return;
      outgoingMessage = { type: "relay-audio", from: state.userKey, data: message.data, sampleRate: 16000 };
    } else {
      if (typeof message.data !== "string" || message.data.length > 220000) return;
      outgoingMessage = { type: "relay-video", from: state.userKey, data: message.data, sharing: message.sharing === true };
    }
    const outgoing = JSON.stringify(outgoingMessage);
    for (const [userKey, peerSocket] of participants.entries()) {
      if (userKey !== state.userKey) sendText(peerSocket, outgoing);
    }
    return;
  }

  if (message.type === "hangup") {
    for (const [userKey, peerSocket] of participants.entries()) {
      if (userKey !== state.userKey && !call.groupId) {
        sendText(peerSocket, JSON.stringify({ type: "hangup", from: state.userKey }));
      }
    }
    removeCallSocket(state, socket, true);
    return;
  }

  if (message.type === "screen-state") {
    const outgoing = JSON.stringify({ type: "screen-state", sharing: message.sharing === true, from: state.userKey });
    for (const [userKey, peerSocket] of participants.entries()) {
      if (userKey !== state.userKey) sendText(peerSocket, outgoing);
    }
    return;
  }

  let targetKey = String(message.to || "").trim().toLowerCase();
  if (!targetKey && participants.size === 2) {
    targetKey = [...participants.keys()].find((userKey) => userKey !== state.userKey) || "";
  }
  const targetSocket = participants.get(targetKey);
  if (!targetSocket || targetKey === state.userKey) return;
  const outgoingMessage = { type: message.type, from: state.userKey };
  if (message.type === "offer" || message.type === "answer") outgoingMessage.description = message.description;
  if (message.type === "ice") outgoingMessage.candidate = message.candidate;
  sendText(targetSocket, JSON.stringify(outgoingMessage));
}

function processFrames(socket, state, chunk, textHandler = null) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const final = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (state.buffer.length < 4) return;
      length = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (state.buffer.length < 10) return;
      const bigLength = state.buffer.readBigUInt64BE(2);
      if (bigLength > BigInt(MAX_FRAME_BYTES)) return closeSocket(socket, 1009, "Frame too large");
      length = Number(bigLength);
      offset = 10;
    }
    if (length > MAX_FRAME_BYTES) return closeSocket(socket, 1009, "Frame too large");
    if (!masked) return closeSocket(socket, 1002, "Client frames must be masked");
    if (state.buffer.length < offset + 4 + length) return;

    const mask = state.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(state.buffer.subarray(offset, offset + length));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    state.buffer = state.buffer.subarray(offset + length);

    if (!final) return closeSocket(socket, 1003, "Fragmented frames are not supported");
    if (opcode === 0x8) return closeSocket(socket);
    if (opcode === 0x9) {
      socket.write(makeFrame(payload, 0x0a));
      continue;
    }
    if (opcode === 0x1) {
      const text = payload.toString("utf8");
      if (textHandler) textHandler(text);
      else handleText(socket, state, text);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of callTokens.entries()) {
    if (session.expiresAt < now) callTokens.delete(token);
  }
  for (const [callId, call] of calls.entries()) {
    if (call.createdAt + 2 * 60 * 60 * 1000 < now) calls.delete(callId);
  }
  for (const [launchKey, launch] of callLaunches.entries()) {
    if (launch.expiresAt < now) callLaunches.delete(launchKey);
  }
  for (const [token, session] of mediaTokens.entries()) {
    if (session.expiresAt < now) mediaTokens.delete(token);
  }
}, 60_000).unref();

const server = http.createServer((request, response) => {
  const requestPath = String(request.url || "/").split("?")[0];
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const requestProtocol = forwardedProtocol || (request.socket.encrypted ? "https" : "http");
  const requestHost = String(request.headers.host || `localhost:${PORT}`);
  const publicAccess = requestProtocol === "https" && !/^(localhost|127\.0\.0\.1)(:|$)/i.test(requestHost);
  const pageOrigin = `${requestProtocol}://${requestHost}`;
  const gatewayAddress = `${requestProtocol === "https" ? "wss" : "ws"}://${requestHost}/ws`;
  const escapedGatewayAddress = escapeHTML(gatewayAddress);
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
  };
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...corsHeaders,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-File-Name",
    });
    response.end();
    return;
  }
  if (requestPath === "/health") {
    response.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, pid: process.pid, version: PROJECT_VERSION, onlineUsers: onlineUsers.size, savedMessages: database.messages.length, groups: Object.keys(database.groups).length, groupMessages: database.groupMessages.length, activeCalls: calls.size }));
    return;
  }
  if (request.method === "GET" && requestPath === "/api/call/launch") {
    const parsed = new URL(request.url || "/", "http://localhost");
    const launchKey = parsed.searchParams.get("key") || "";
    if (!/^[a-z0-9_-]{16,100}$/i.test(launchKey)) {
      sendJson(response, 400, { ok: false, error: "Invalid call launch." });
      return;
    }
    const launch = callLaunches.get(launchKey);
    if (!launch) {
      sendJson(response, 202, { ok: false, pending: true });
      return;
    }
    callLaunches.delete(launchKey);
    const { statusCode, expiresAt, ...payload } = launch;
    sendJson(response, statusCode, payload);
    return;
  }
  if (request.method === "POST" && requestPath === "/api/media/start") {
    void handleMediaStart(request, response);
    return;
  }
  if (request.method === "GET" && requestPath === "/api/media/session") {
    const parsed = new URL(request.url || "/", "http://localhost");
    const session = mediaSession(parsed.searchParams.get("token") || "");
    if (!session) return sendJson(response, 401, { ok: false, error: "This media link expired. Open MEDIA from WhatsChat again." });
    sendJson(response, 200, mediaSessionPayload(session, pageOrigin));
    return;
  }
  if (request.method === "POST" && requestPath === "/api/media/send") {
    const parsed = new URL(request.url || "/", "http://localhost");
    const session = mediaSession(parsed.searchParams.get("token") || "");
    if (!session) return sendJson(response, 401, { ok: false, error: "This media link expired. Open MEDIA from WhatsChat again." });
    void handleMediaUpload(request, response, session, pageOrigin);
    return;
  }
  if (request.method === "POST" && ["/api/media/contact", "/api/media/contact/save", "/api/media/poll", "/api/media/poll/vote"].includes(requestPath)) {
    const parsed = new URL(request.url || "/", "http://localhost");
    const session = mediaSession(parsed.searchParams.get("token") || "");
    if (!session) return sendJson(response, 401, { ok: false, error: "This media link expired. Open MEDIA from WhatsChat again." });
    if (requestPath === "/api/media/contact") void handleShareContact(request, response, session);
    else if (requestPath === "/api/media/contact/save") void handleSaveSharedContact(request, response, session);
    else if (requestPath === "/api/media/poll") void handleCreatePoll(request, response, session);
    else void handlePollVote(request, response, session);
    return;
  }
  if (request.method === "POST" && ["/api/call/start", "/api/call/answer", "/api/call/reject"].includes(requestPath)) {
    void handleCallApi(request, response, requestPath);
    return;
  }
  if (requestPath === "/whatschat-call-launcher.js") {
    if (!fs.existsSync(CALL_EXTENSION_FILE)) {
      response.writeHead(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
      response.end("Call launcher not found.\n");
      return;
    }
    response.writeHead(200, { ...corsHeaders, "Content-Type": "application/javascript; charset=utf-8" });
    fs.createReadStream(CALL_EXTENSION_FILE).pipe(response);
    return;
  }
  if (requestPath === "/call.html") {
    if (!fs.existsSync(CALL_PAGE_FILE)) {
      response.writeHead(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
      response.end("Call page not found.\n");
      return;
    }
    response.writeHead(200, { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(CALL_PAGE_FILE).pipe(response);
    return;
  }
  if (requestPath === "/media.html") {
    if (!fs.existsSync(MEDIA_PAGE_FILE)) {
      response.writeHead(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
      response.end("Media studio not found.\n");
      return;
    }
    response.writeHead(200, { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" });
    fs.createReadStream(MEDIA_PAGE_FILE).pipe(response);
    return;
  }
  if (request.method === "GET" && requestPath.startsWith("/media/")) {
    const id = requestPath.slice("/media/".length);
    if (!/^[a-f0-9]{36}$/.test(id)) {
      response.writeHead(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
      response.end("Media not found.\n");
      return;
    }
    const message = [...database.messages, ...database.groupMessages].find((item) => item.attachment && item.attachment.id === id);
    const attachment = message && message.attachment;
    const filePath = attachment ? path.join(UPLOAD_DIR, `${id}${attachment.extension || ""}`) : "";
    if (!attachment || !fs.existsSync(filePath)) {
      response.writeHead(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
      response.end("Media not found.\n");
      return;
    }
    const inline = /^(image|audio|video)\//.test(attachment.mime) || attachment.mime === "application/pdf";
    response.writeHead(200, {
      ...corsHeaders,
      "Content-Type": attachment.mime,
      "Content-Length": fs.statSync(filePath).size,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    });
    fs.createReadStream(filePath).pipe(response);
    return;
  }
  if (requestPath === "/project.sb3" || requestPath === "/project-public.sb3") {
    const wantsPublicProject = requestPath === "/project-public.sb3";
    const selectedProject = wantsPublicProject && fs.existsSync(PUBLIC_PROJECT_FILE) ? PUBLIC_PROJECT_FILE : PROJECT_FILE;
    if (!fs.existsSync(selectedProject)) {
      response.writeHead(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
      response.end("The project file was not found beside the server folder.\n");
      return;
    }
    response.writeHead(200, {
      ...corsHeaders,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${wantsPublicProject ? "WhatsChat_Public_TurboWarp.sb3" : "WhatsChat_Live_TurboWarp.sb3"}"`,
    });
    fs.createReadStream(selectedProject).pipe(response);
    return;
  }
  if (requestPath !== "/" && requestPath !== "/index.html") {
    response.writeHead(404, { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }
  const projectRoute = publicAccess ? "/project-public.sb3" : "/project.sb3";
  const projectDownloadURL = `${pageOrigin}${projectRoute}?version=${PROJECT_VERSION}`;
  const turboWarpURL = `https://turbowarp.org/editor?project_url=${encodeURIComponent(projectDownloadURL)}`;
  response.writeHead(200, { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsChat Live Server</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 15% 10%,#20a77a66,transparent 34%),radial-gradient(circle at 90% 90%,#58a9ff44,transparent 36%),linear-gradient(135deg,#02191d,#075e54);font-family:Arial,sans-serif;color:#12362f}.card{width:min(650px,92vw);background:linear-gradient(145deg,#fbfffd,#edf8f4);border:1px solid #ffffffaa;border-radius:28px;padding:32px;box-shadow:0 24px 80px #001c1877}.head{display:flex;gap:18px;align-items:center}.logo{width:64px;height:64px;border-radius:22px;display:grid;place-items:center;background:linear-gradient(145deg,#4bed91,#15b866);color:white;font-size:34px;font-weight:900;box-shadow:0 10px 25px #0b815755}h1{margin:0 0 5px;font-size:29px}.tag{display:inline-block;margin-top:8px;padding:5px 9px;border-radius:999px;background:#d9f8ea;color:#087159;font-size:11px;font-weight:900;letter-spacing:.5px}.status{display:flex;align-items:center;gap:12px;margin:22px 0 12px;padding:15px 17px;border:1px solid #c8e9dd;border-radius:16px;background:#fff;font-weight:900;box-shadow:0 5px 16px #0c654413}.dot{width:13px;height:13px;border-radius:50%;background:#f59e0b}.dot.ok{background:#22c55e;box-shadow:0 0 0 6px #22c55e22}.gateway{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin:0 0 18px;padding:12px 14px;border-radius:15px;background:#ddf4ec;border:1px solid #bfe3d6}.gateway span{grid-column:1/-1;font-size:10px;font-weight:900;letter-spacing:.8px;color:#397067}.gateway code{overflow-wrap:anywhere;font-size:12px;font-weight:800;color:#075e54}.copy{border:0;border-radius:10px;padding:8px 11px;background:#087a62;color:#fff;font-weight:900;cursor:pointer}.buttons{display:grid;gap:12px}.button{display:block;text-align:center;text-decoration:none;padding:15px 18px;border-radius:16px;background:linear-gradient(90deg,#37df7f,#16b967);color:#053b29;font-weight:900;border:1px solid #b5f5d0;box-shadow:0 8px 18px #0a75452b}.button.secondary{background:#fff;border-color:#a8d6c7;color:#075e54;box-shadow:none}.note{font-size:13px;line-height:1.5;color:#5b756e;margin-bottom:0}code{background:#e2f0eb;padding:3px 6px;border-radius:7px}</style></head>
<body><main class="card"><div class="head"><div class="logo">✓</div><div><h1>${publicAccess ? "WhatsChat Public WSS" : "WhatsChat Local Gateway"}</h1><div>${publicAccess ? "This encrypted public gateway works from the same computer and different computers." : "Local messaging is ready. Start the public launcher for different computers."}</div><span class="tag">${publicAccess ? "WORKS ACROSS THE INTERNET" : "NO NODE.JS INSTALL NEEDED"}</span></div></div>
<div class="status"><span class="dot" id="dot"></span><span id="status">Checking the messaging gateway…</span></div>
<div class="gateway"><span>${publicAccess ? "PUBLIC WSS GATEWAY ADDRESS" : "LOCAL GATEWAY ADDRESS"}</span><code id="gatewayAddress">${escapedGatewayAddress}</code><button class="copy" id="copyGateway" type="button">COPY</button></div>
<div class="buttons"><a class="button" href="${turboWarpURL}" target="_blank" rel="noreferrer">${publicAccess ? "Open the Public WhatsChat Project" : "Open the Local WhatsChat Project"}</a><a class="button secondary" href="${projectRoute}?version=${PROJECT_VERSION}">Download this .sb3 project</a></div>
<p class="note">${publicAccess ? "Share this HTTPS page address with the other people. Keep your computer and START_PUBLIC_WHATSCHAT running. Group chats, calls, screen sharing, contact cards, polls, HTML downloads, voice messages, GIFs, and file attachments use this WhatsChat gateway." : "For direct messages, group chats, contact sharing, polls, media, and calls on other computers, double-click START_PUBLIC_WHATSCHAT.cmd. Offline messages and attachments are stored on the gateway computer."}</p></main>
<script>
const statusText=document.getElementById('status');const dot=document.getElementById('dot');const copyGateway=document.getElementById('copyGateway');copyGateway.onclick=async()=>{try{await navigator.clipboard.writeText(document.getElementById('gatewayAddress').textContent);copyGateway.textContent='COPIED'}catch(error){copyGateway.textContent='SELECT ADDRESS'}};
try{const socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');socket.onopen=()=>{dot.classList.add('ok');statusText.textContent='Messaging gateway is online and ready';setTimeout(()=>socket.close(),600)};socket.onerror=()=>{statusText.textContent='Gateway test failed. Run START_WHATSCHAT_LIVE.cmd again.'}}catch(error){statusText.textContent='Gateway test failed'}
</script></body></html>`);
});

function acceptWebSocket(request, socket) {
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return false;
  }
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return true;
}

server.on("upgrade", (request, socket) => {
  const parsed = new URL(request.url || "/", "http://localhost");
  if (parsed.pathname === "/call-ws") {
    const token = parsed.searchParams.get("token") || "";
    const session = callTokens.get(token);
    const call = session ? calls.get(session.callId) : null;
    const allowedParticipant = session && call && (
      session.userKey === call.caller || call.decisions?.[session.userKey] === "accepted"
    );
    if (!session || !call || session.expiresAt < Date.now() || !allowedParticipant || ["ended", "rejected"].includes(call.status)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    if (!acceptWebSocket(request, socket)) return;
    callTokens.delete(token);
    const state = { buffer: Buffer.alloc(0), callId: call.id, userKey: session.userKey };
    if (!callSockets.has(call.id)) callSockets.set(call.id, new Map());
    const participants = callSockets.get(call.id);
    const previous = participants.get(session.userKey);
    if (previous && previous !== socket) closeSocket(previous, 1000, "Call reopened");
    const existingPeers = [...participants.keys()]
      .filter((userKey) => userKey !== session.userKey)
      .map((userKey) => ({ userKey, display: callParticipantDisplay(userKey) }));
    participants.set(session.userKey, socket);
    const role = session.userKey === call.caller ? "caller" : "participant";
    sendText(socket, JSON.stringify({
      type: "session",
      selfKey: session.userKey,
      role,
      mode: call.mode,
      peerDisplay: callLabel(call),
      groupCall: Boolean(call.groupId),
      relayAvailable: true,
      peers: existingPeers,
    }));
    for (const [userKey, participant] of participants.entries()) {
      if (userKey !== session.userKey) {
        sendText(participant, JSON.stringify({ type: "peer-joined", userKey: session.userKey, display: callParticipantDisplay(session.userKey) }));
      }
    }
    if (!call.groupId && participants.size === 2) {
      for (const participant of participants.values()) sendText(participant, JSON.stringify({ type: "peer-ready" }));
    }
    socket.on("data", (chunk) => processFrames(socket, state, chunk, (text) => handleCallSignal(socket, state, text)));
    socket.on("close", () => removeCallSocket(state, socket));
    socket.on("error", () => removeCallSocket(state, socket));
    return;
  }

  if (parsed.pathname !== "/ws" && parsed.pathname !== "/") {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  if (!acceptWebSocket(request, socket)) return;
  const state = { buffer: Buffer.alloc(0), userKey: null, sentTimes: [] };
  clients.set(socket, state);
  sendText(socket, "SYSTEM: Connected to WhatsChat Live. Signing in...");
  socket.on("data", (chunk) => processFrames(socket, state, chunk));
  socket.on("close", () => {
    removeOnline(state, socket);
    clients.delete(socket);
  });
  socket.on("error", () => {
    removeOnline(state, socket);
    clients.delete(socket);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsChat Live server listening on http://localhost:${PORT}`);
  console.log(`WebSocket address: ws://localhost:${PORT}/ws`);
  console.log(`Data file: ${DATA_FILE}`);
});

function shutdown() {
  saveDatabase();
  for (const socket of clients.keys()) closeSocket(socket, 1001, "Server stopping");
  for (const participants of callSockets.values()) {
    for (const socket of participants.values()) closeSocket(socket, 1001, "Server stopping");
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
