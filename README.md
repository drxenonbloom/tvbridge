# TV Bridge

A self-hosted web app that makes installing an APK on Google TV or Android TV a simple two-step task: connect by IP, then paste a download link. The browser shows actual download progress and live ADB output, with clear success and error messages.

## Run with Docker

Install Docker with Compose on a computer on the same network as your TV, then run from this folder:

```sh
docker compose up -d --build
```

Open **http://localhost:3000**. Google's Platform Tools 37.0.1 (including modern wireless pairing) are included in the image; you do not need to install ADB on your computer. The first build downloads the base image, Debian packages, and the official Platform Tools archive. This project has no npm dependencies. The image uses `linux/amd64`, the architecture supported by Google's Linux binaries; ARM Docker hosts need amd64 emulation. For a direct Docker build, pass `--platform=linux/amd64`.

The default port binding permits access from the Docker host only. To change settings, copy `.env.example` to `.env`, edit it, then rerun `docker compose up -d`. To access the interface from another computer, set `BIND_ADDRESS=0.0.0.0` and a strong `APP_PASSWORD`, then visit `http://DOCKER-HOST-IP:3000`. The login accepts any username and your configured password. For access beyond a trusted home network, use an HTTPS reverse proxy and restrict network access; Basic authentication needs HTTPS to protect credentials in transit. Add any custom hostname to `APP_ALLOWED_HOSTS`.

## Prepare your TV

1. Put the TV and Docker host on the same network.
2. On Google TV, open **Settings → System → About** and select **Android TV OS build** seven times to enable developer options. Menu names vary by model.
3. For Android 14 TVs, start with **System → Developer options → Wireless debugging** if the TV offers it. Turn it on and allow debugging on your home network if prompted. Availability and menu names vary by manufacturer; USB debugging alone may not enable network access.
4. Open **Pair device with pairing code**. Keep the popup open. Enter its IP, pairing port, and separate six-digit code in the app's **Pair a device** form, then choose **Pair TV**.
5. The app tries to connect the paired TV automatically. If it shows **TV paired. One more step.**, close the TV's pairing popup and use the connection port from the main **Wireless debugging → IP address & port** screen. Choose **Finish connecting**. Pairing is already saved; you do not need a second code.
6. Wait for the **CONNECTED** badge, then paste a direct APK URL or select a saved app link and choose **Install on TV**.

The app's **Setup guide** includes labeled recreations of both TV screens. Choose **See the TV screens & what to enter** next to the connection form or **Show me which number goes where** in the pairing form.

| Example shown on the TV | Part to copy | App field |
| --- | --- | --- |
| Pairing popup: `192.168.1.42:37099` | `192.168.1.42`, before the colon (`:`) | Pair a device → TV IP address |
| Same pairing popup | `37099`, after the colon | Pairing port |
| Separate Wi-Fi pairing code: `123456` | All six digits, `123456` | Six-digit code |
| Main Wireless debugging screen: `192.168.1.42:41113` | `192.168.1.42`, before the colon | Connect your TV → TV IP address |
| Same main screen | `41113`, after the colon | Connection port |

These are examples, not values to copy literally. Use the numbers from your TV. The pairing and connection ports are different; the six-digit code is neither of those ports. Wireless debugging chooses its own ports, so do not assume `5555` will work. If a saved TV stops connecting after a restart or toggling Wireless debugging, update its connection port using **Edit**. If a pairing code expires, open a fresh pairing popup and use its current code and pairing port.

If Wireless debugging is missing, check for **Network debugging** or **ADB debugging**. Some older TVs accept network ADB on port **5555** and may also require USB debugging enabled. Use the TV's displayed port when available, approve its debugging prompt, and follow the manufacturer's instructions if those options are absent. The guide keeps this alternate path separate from wireless pairing.

Some TVs require an initial USB connection to enable network ADB; this app cannot enable a disabled debugging service remotely. If the connection fails, check the debugging port, TV prompt, firewall, VPN, and guest Wi-Fi/client-isolation settings. Docker Desktop must be able to reach the TV's IP; no inbound port needs to be opened on the TV's behalf.

See the official [Android ADB guide](https://developer.android.com/tools/adb) for wireless debugging details and device prerequisites. Wireless pairing is only available on supported TV versions/models.

## What is supported

- IPv4 connection with a configurable port, wireless pairing, and disconnect.
- Public HTTP/HTTPS links to a single APK, including redirects and signed download URLs. Download URLs are not included in the terminal log; the source hostname is shown.
- Measured download progress, SHA-256 checksum, bounded terminal output, and reconnecting live updates through server-sent events.
- Installing or updating an existing app using `adb install -r --no-streaming`. Updating preserves app data when supported by Android and the app's signature matches. Uncheck the update option to omit `-r`.
- Cancellation, sequential operations, actionable ADB errors, and automatic removal of downloaded files after completion or failure.
- Saved TVs with a familiar name, last connection address, and a **Connect** button. Successful connections are remembered automatically. Use **Edit** to rename a TV or update its IP/port; removing a saved profile does not revoke ADB authorization or disconnect an active TV.
- Named APK presets under **Saved app links**. Use **Save a link** to add one, select it to fill the APK field, and choose **Install on TV** when ready. Saved links can be edited or removed. They are shared with everyone who can access this app, including any tokens in the saved URL.
- Persistent ADB keys in the `adb-keys` Docker volume and saved TVs/app links in the separate `app-data` volume. Both survive container restarts and recreations. Jobs and logs live in memory; a server restart clears the active connection, so select a saved TV and choose **Connect** afterward.

APK download percentages are measured from received bytes when the source provides a size. During installation, the UI streams real ADB output and shows an indeterminate progress bar, because many TV/ADB combinations do not report installation percentages. Cancelling after package installation starts cannot guarantee rollback; check the TV before retrying.

Only single APKs are supported. Store pages, login-protected links, XAPK/APKM archives, and split-APK bundles are not supported. Use a trusted APK compatible with your TV's Android version and processor. Some sideloaded apps do not have a TV launcher entry; look under **Settings → Apps**.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `BIND_ADDRESS` | `127.0.0.1` | Compose host interface exposed to browsers |
| `PORT` | `3000` | Compose host port; native Node also uses it as the server port |
| `APP_PASSWORD` | empty | Optional browser Basic authentication |
| `APP_ALLOWED_HOSTS` | empty | Extra allowed hostnames, comma separated; numeric IPs and `localhost` work by default |
| `MAX_APK_MB` | `512` | Maximum download size; increasing this also requires increasing Compose's `/tmp` size |
| `ADB_PATH` | `adb` | Native development only: path to the ADB executable |
| `HOST` | `127.0.0.1` | Native server interface; Docker sets `0.0.0.0` inside the container |
| `DATA_DIR` | `./data` natively | Folder holding `library.json`; Docker uses `/home/node/data` on the persistent `app-data` volume |

The server downloads APKs into temporary storage, checks ZIP magic bytes, and delegates final APK validation to Android's package installer. Private, loopback, metadata, and reserved download addresses are blocked, including after redirects. DNS results are pinned to the validated connection. APK download hosts need an IPv4 address. Device connections use a separate validated IPv4 input. ADB is invoked with argument arrays without a shell. Pairing codes are sent over stdin. No arbitrary terminal command endpoint is exposed.

This is a shared household tool: everyone with access controls the same selected device and sees the same current operation. Keep it on a trusted network. The app does not require privileged containers, host networking, USB access, or access to the Docker socket. The container runs as a non-root user.

## Development and verification

Use Node.js 24 or newer and install Android Platform Tools if running outside Docker:

```sh
npm start
npm run check
npm test
```

On PowerShell installations that block `npm.ps1`, use `npm.cmd` instead. `npm run dev` restarts the server when backend files change. Without a local ADB binary, the interface still opens and explains how to run with Docker.

Tests exercise the HTTP API, live event stream, authentication, pairing, cancellation, download redirects/limits, private-address rejection, and file cleanup. ADB calls are mocked in automated tests; a real TV is required to verify a complete installation on hardware.

```sh
docker compose logs -f
docker compose down
```

`docker compose down` retains pairing keys, saved TVs, and preset links. `docker compose down -v` deletes both volumes, including saved settings, and requires authorizing this server on the TV again. Back up the `app-data` volume to preserve `library.json`. The library supports up to 50 TVs and 50 app links; writes are serialized and use atomic file replacement.
