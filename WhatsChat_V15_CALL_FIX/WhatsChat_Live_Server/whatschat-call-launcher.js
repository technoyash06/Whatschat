(function (Scratch) {
  "use strict";

  const BlockType = Scratch.BlockType;
  const ArgumentType = Scratch.ArgumentType;

  class WhatsChatCalls {
    getInfo() {
      return {
        id: "whatschatcalls",
        name: "WhatsChat Calls",
        color1: "#0bbf72",
        color2: "#07965b",
        blocks: [
          {
            opcode: "startCall",
            blockType: BlockType.COMMAND,
            text: "start [MODE] call using [GATEWAY] as [USERNAME] passcode [PASSCODE] with [TARGET]",
            arguments: {
              MODE: { type: ArgumentType.STRING, menu: "callMode", defaultValue: "voice" },
              GATEWAY: { type: ArgumentType.STRING, defaultValue: "ws://localhost:8080/ws" },
              USERNAME: { type: ArgumentType.STRING, defaultValue: "Alice" },
              PASSCODE: { type: ArgumentType.STRING, defaultValue: "1234" },
              TARGET: { type: ArgumentType.STRING, defaultValue: "Bob" },
            },
          },
          {
            opcode: "prepareCallLink",
            blockType: BlockType.REPORTER,
            text: "prepare [MODE] call link using [GATEWAY] as [USERNAME] passcode [PASSCODE] with [TARGET]",
            arguments: {
              MODE: { type: ArgumentType.STRING, menu: "callMode", defaultValue: "voice" },
              GATEWAY: { type: ArgumentType.STRING, defaultValue: "ws://localhost:8080/ws" },
              USERNAME: { type: ArgumentType.STRING, defaultValue: "Alice" },
              PASSCODE: { type: ArgumentType.STRING, defaultValue: "1234" },
              TARGET: { type: ArgumentType.STRING, defaultValue: "Bob" },
            },
          },
          {
            opcode: "answerCall",
            blockType: BlockType.COMMAND,
            text: "answer call [CALLDATA] using [GATEWAY] as [USERNAME] passcode [PASSCODE]",
            arguments: {
              CALLDATA: { type: ArgumentType.STRING, defaultValue: "incoming call data" },
              GATEWAY: { type: ArgumentType.STRING, defaultValue: "ws://localhost:8080/ws" },
              USERNAME: { type: ArgumentType.STRING, defaultValue: "Alice" },
              PASSCODE: { type: ArgumentType.STRING, defaultValue: "1234" },
            },
          },
          {
            opcode: "prepareAnswerLink",
            blockType: BlockType.REPORTER,
            text: "prepare answer link [CALLDATA] using [GATEWAY] as [USERNAME] passcode [PASSCODE]",
            arguments: {
              CALLDATA: { type: ArgumentType.STRING, defaultValue: "incoming call data" },
              GATEWAY: { type: ArgumentType.STRING, defaultValue: "ws://localhost:8080/ws" },
              USERNAME: { type: ArgumentType.STRING, defaultValue: "Alice" },
              PASSCODE: { type: ArgumentType.STRING, defaultValue: "1234" },
            },
          },
          {
            opcode: "rejectCall",
            blockType: BlockType.COMMAND,
            text: "reject call [CALLDATA] using [GATEWAY] as [USERNAME] passcode [PASSCODE]",
            arguments: {
              CALLDATA: { type: ArgumentType.STRING, defaultValue: "incoming call data" },
              GATEWAY: { type: ArgumentType.STRING, defaultValue: "ws://localhost:8080/ws" },
              USERNAME: { type: ArgumentType.STRING, defaultValue: "Alice" },
              PASSCODE: { type: ArgumentType.STRING, defaultValue: "1234" },
            },
          },
          {
            opcode: "prepareMediaLink",
            blockType: BlockType.REPORTER,
            text: "prepare media studio link using [GATEWAY] as [USERNAME] passcode [PASSCODE] with [TARGET]",
            arguments: {
              GATEWAY: { type: ArgumentType.STRING, defaultValue: "ws://localhost:8080/ws" },
              USERNAME: { type: ArgumentType.STRING, defaultValue: "Alice" },
              PASSCODE: { type: ArgumentType.STRING, defaultValue: "1234" },
              TARGET: { type: ArgumentType.STRING, defaultValue: "Bob" },
            },
          },
        ],
        menus: {
          callMode: { acceptReporters: true, items: ["voice", "video"] },
        },
      };
    }

    gatewayOrigin(gateway) {
      const value = String(gateway || "").trim().replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
      return new URL(value).origin;
    }

    async request(origin, pathname, payload) {
      const fetcher = Scratch.fetch || fetch;
      const response = await fetcher(`${origin}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let result = {};
      try {
        result = await response.json();
      } catch {
        throw new Error("The gateway returned an invalid call response.");
      }
      if (!response.ok || !result.ok) throw new Error(result.error || "The call could not start.");
      return result;
    }

    async openCall(origin, relativePath) {
      const address = new URL(relativePath, origin).href;
      if (Scratch.openWindow) {
        await Scratch.openWindow(address, "noopener,noreferrer");
      } else if (Scratch.canOpenWindow && await Scratch.canOpenWindow(address) && typeof window !== "undefined") {
        window.open(address, "_blank", "noopener,noreferrer");
      } else {
        throw new Error("TurboWarp did not allow the calling platform to open.");
      }
    }

    newLaunchKey() {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    }

    showError(error) {
      const message = `WhatsChat call: ${error && error.message ? error.message : error}`;
      console.error(message);
      if (typeof alert === "function") alert(message);
    }

    callId(callData) {
      const parts = String(callData || "").split("|");
      if (parts[0] !== "[INCOMING CALL]" || !parts[1]) throw new Error("There is no incoming call to answer.");
      return parts[1];
    }

    async startCall(args) {
      try {
        const origin = this.gatewayOrigin(args.GATEWAY);
        const launchKey = this.newLaunchKey();
        const opening = this.openCall(origin, `/call.html#launch=${launchKey}`);
        const starting = this.request(origin, "/api/call/start", {
          username: String(args.USERNAME || ""),
          passcode: String(args.PASSCODE || ""),
          target: String(args.TARGET || ""),
          mode: String(args.MODE || "voice"),
          launchKey,
        });
        await Promise.all([opening, starting]);
      } catch (error) {
        this.showError(error);
      }
    }

    async prepareCallLink(args) {
      const origin = this.gatewayOrigin(args.GATEWAY);
      const launchKey = this.newLaunchKey();
      await this.request(origin, "/api/call/start", {
        username: String(args.USERNAME || ""),
        passcode: String(args.PASSCODE || ""),
        target: String(args.TARGET || ""),
        mode: String(args.MODE || "voice"),
        launchKey,
      });
      return new URL(`/call.html#launch=${launchKey}`, origin).href;
    }

    async answerCall(args) {
      try {
        const origin = this.gatewayOrigin(args.GATEWAY);
        const launchKey = this.newLaunchKey();
        const opening = this.openCall(origin, `/call.html#launch=${launchKey}`);
        const answering = this.request(origin, "/api/call/answer", {
          username: String(args.USERNAME || ""),
          passcode: String(args.PASSCODE || ""),
          callId: this.callId(args.CALLDATA),
          launchKey,
        });
        await Promise.all([opening, answering]);
      } catch (error) {
        this.showError(error);
      }
    }

    async prepareAnswerLink(args) {
      const origin = this.gatewayOrigin(args.GATEWAY);
      const launchKey = this.newLaunchKey();
      await this.request(origin, "/api/call/answer", {
        username: String(args.USERNAME || ""),
        passcode: String(args.PASSCODE || ""),
        callId: this.callId(args.CALLDATA),
        launchKey,
      });
      return new URL(`/call.html#launch=${launchKey}`, origin).href;
    }

    async rejectCall(args) {
      try {
        const origin = this.gatewayOrigin(args.GATEWAY);
        await this.request(origin, "/api/call/reject", {
          username: String(args.USERNAME || ""),
          passcode: String(args.PASSCODE || ""),
          callId: this.callId(args.CALLDATA),
        });
      } catch (error) {
        this.showError(error);
      }
    }

    async prepareMediaLink(args) {
      const origin = this.gatewayOrigin(args.GATEWAY);
      const result = await this.request(origin, "/api/media/start", {
        username: String(args.USERNAME || ""),
        passcode: String(args.PASSCODE || ""),
        target: String(args.TARGET || ""),
      });
      return new URL(result.path, origin).href;
    }
  }

  Scratch.extensions.register(new WhatsChatCalls());
})(Scratch);
