# WhatsChat Live server

This gateway gives the TurboWarp Scratch project real direct and group message delivery, offline inboxes, persistent group membership, and resilient voice/video calls. Calls try peer-to-peer WebRTC first and automatically use a live gateway media relay when the network blocks the direct connection. It uses no extra packages, and the complete kit includes its own portable runtime.

## Test it on one computer

1. Extract the complete kit ZIP.
2. Double-click `START_WHATSCHAT_LIVE.cmd` beside this server folder.
3. Wait for the green ready message at `http://localhost:8080/`.
4. Open two TurboWarp editor tabs and load `WhatsChat_Live_TurboWarp.sb3` in both.
5. Click the green flag in each tab and create two different usernames and passcodes.
6. Click **NEW CONTACT**, type the other username, then click **SEND**.
7. Open a contact or group and click **VOICE**, **VIDEO**, or **MEDIA**. Calls support screen sharing. Media Studio supports voice messages, camera, photos, videos, GIF creation, general file uploads, downloadable HTML files, contact cards, and interactive polls.

## Group chats

1. Register every username that should join.
2. Click **CREATE GROUP** in Scratch, type a name, then enter usernames separated by commas.
3. Click **MY GROUPS** to see the generated 8-character group code.
4. Use **OPEN GROUP** with that code to send text, emojis, GIF links, animated stickers, and Media Studio attachments.
5. Owners can add members or delete the group; other members can leave.

For a group voice or video call, all online members receive an invitation. Each person can answer or decline independently. People who answer remain connected, people who decline are excluded, and the call ends if everyone declines. A connected person can leave without removing the other participants.

Group messages are saved for signed-out members and delivered at their next login. A member added later cannot read messages sent before they joined.

HTML uploads are always returned as downloads with browser-sniffing disabled; WhatsChat does not display or run uploaded HTML inside its own pages.

The default project address is `ws://localhost:8080/ws`.
Do not type that `ws://` address into a normal browser tab; it is the project's connection address, not a webpage.

## Use it between different devices

For the included free option, double-click `START_PUBLIC_WHATSCHAT.cmd` and share the HTTPS page it opens. Keep the gateway computer running. The public Scratch project is configured automatically with the correct secure messaging and call addresses.

Messages sent while an account is signed out are stored here. At the next login, WhatsChat shows who sent them and how many arrived. Calls require both accounts to be online and open in a separate browser tab that asks for microphone/camera permission.

For saved messages to survive server restarts, attach persistent storage and set `DATA_FILE` to a path on that storage.

## Important limits

- This is a working educational messenger, not WhatsApp.
- Accounts use a username and passcode. Passcodes are salted and hashed on the server.
- Messages are stored as readable text and are **not end-to-end encrypted**. Do not use it for secrets or sensitive information.
- Call media uses peer-to-peer WebRTC when possible. On restrictive networks, compressed live audio/video frames pass through the WhatsChat WSS gateway and are not stored. Calls are not end-to-end encrypted.
- Add moderation, reporting, backups, HTTPS/WSS, and stronger authentication before making it public.
