# LobsterLink public web client

This directory is a plain static site that hosts the LobsterLink viewer as a public web page.
It is the same `viewer.html` / `viewer.js` used by the extension, but served over HTTPS
so anyone with a peer ID can connect to a running LobsterLink host without installing the
extension.

## Files

- `index.html` — viewer UI (copied from repo-root `viewer.html`)
- `viewer.js` — viewer logic (copied from repo-root `viewer.js`, with the same-window
  warning guarded so it is safe to run outside the extension)
- `lib/peerjs.min.js` — PeerJS client library

## Serving

Everything in this directory is plain static content. There is no build step and no
server-side code. Point any static file server or static hosting provider at this
directory and serve its contents as-is.

For quick local preview you can use anything that serves a directory, for example:

```bash
python3 -m http.server --directory client 8000
```

## Usage

Open the deployed URL and paste a host peer ID, or pass it in the query string:

```
https://lobsterl.ink/?host=<host-peer-id>
```

The page connects to the LobsterLink host over WebRTC via PeerJS and renders the shared
tab with remote input forwarded back.
