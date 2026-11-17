# Block Drop Battle

`block-drop-battle` is a two-player block-dropping game played on two PixelMug S1 devices. A Bot coordinates the match, each player's WebApp controls their own device over BLE, and the Bot keeps group leaderboards.

## Play a match

1. Add the Bot and both players to the same group chat.
2. Use `/bindDevice` in the group. Each player binds their own PixelMug S1 to a different device slot and connects it so both devices are online.
3. Use `/battle` and open the WebApp link. The Bot sends the link only when both slots hold different players' devices and both devices are online; otherwise it explains what is missing. The WebApp installs and starts the MPS only on the current player's device. A group member without a bound device can view the leaderboards.
4. Each device starts at `JOIN`. Once both players join, the devices show `READY`, then `GO` when the round starts.
5. When both games end, the Bot compares cleared lines and sends `WIN` or `LOSE` to the devices. Equal scores produce `DRAW` and do not count as wins. If one player never starts after `GO`, that player loses with zero lines when the other game ends.
6. Select restart to return to `JOIN` for another round.

## Leaderboards and storage

The WebApp provides a match leaderboard and a personal best leaderboard. Both are scoped to the group chat and are fetched from the Bot without a BLE connection. The Bot records each completed match once, excludes draws from win counts, and updates a player's personal best only when they clear more lines. Unbinding or replacing a device does not erase match history.

The Bot stores group bindings, player profiles, match state, results, leaderboards, and pending device commands in `bot/data/battle.sqlite`. This directory is ignored by Git. You can delete local test data; the Bot recreates the database on its next start. Set `BATTLE_DB_PATH` to use another database file.

## Device message protocol

The devices and Bot exchange game events and commands over the existing MQTT/TAL channel; no separate battle server is required.

```text
Device event: BDB2|<trans_id>|<message_id>|<JOIN|READY|PLAYING|GAME_OVER>|<lines>
Device ACK:   BDB2|<trans_id>|<message_id>|ACK|<command_message_id>
Bot command:  BDB2|<trans_id>|<message_id>|<P1_READY|P2_READY|GO|WIN|LOSE|DRAW>
```

The Bot assigns a transaction ID after both players are ready. Retries keep the same message ID so duplicate reports can be ignored. Devices retry `READY` and `GAME_OVER` every 250 ms until they receive the corresponding command, and report `PLAYING` every 500 ms as a heartbeat. The Bot persists pending commands and acknowledgments in SQLite and retries a failed push when the next device report arrives.

## Run in PixelMug Studio

Use Node.js 24 or later. Open this project directory in PixelMug Studio, configure the Bot token, bind both PixelMug S1 devices, then build and run the project. Studio supplies the WebApp URL and MPS ID and version, and serves the WebApp files. The WebApp starts the MPS automatically when a player opens it.

To check the project locally:

```sh
npm install
npm --prefix webapp install
npm test
npm run build
```

If PixelMug Skill is installed, you can also run its `validate-project.mjs` script with `--build` against this directory.
