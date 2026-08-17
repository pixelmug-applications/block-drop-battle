# 方块落下对战版

`block-drop-battle` 是两名用户、两台 PixelMugS1 的实时俄罗斯方块对战游戏。

## 对战流程

1. 两名玩家和 Bot 必须在同一个群聊中。
2. 在群内执行 `/bindDevice`，两名玩家各选择一个未占用 slot，绑定各自的 PixelMugS1。
3. 执行 `/battle`。用户点击 inline keyboard 时，Bot 检查群聊、两个设备槽、设备所有者和点击用户，通过后才提供 WebApp 入口。
4. WebApp 再次读取共享绑定快照，只在点击用户自己的设备上安装 MPS。
5. MPY 初始显示 `JOIN`；点击加入后显示 `READY`。两台设备都准备好后显示 `GO`。
6. 任一玩家结束时，Bot 判定胜负，两台设备显示 `WIN` / `LOSE` 和各自的消除行数。
7. 点击重新开始回到 `JOIN`，开始下一轮。

## 群组对战榜

WebApp 提供“游戏”和“对战榜”两个视图。每局胜负确定后，Bot 会在不影响
WIN/LOSE 下发的前提下记录本局历史，并按玩家组合汇总双方胜场。

- 排行榜以 `chat_id` 隔离，同一玩家在不同群的成绩互不影响。
- `(chat_id, round_id)` 唯一约束保证重复 GAME_OVER 不会重复计分。
- 玩家解绑或更换设备不会删除历史成绩。
- 用户名和头像保存为群内用户档案，并在绑定设备或打开 WebApp 时更新。
- 排行榜通过 `battle.getLeaderboard` 读取 Bot 数据，不依赖 BLE 连接。

## 可靠消息协议

游戏状态上报和命令下发都复用设备已有的 MQTT/TAL 通道，不需要额外 HTTP 服务或公网 Battle URL。

协议帧格式：

```text
上报：BDB2|<trans_id>|<message_id>|<JOIN|READY|PLAYING|GAME_OVER>|<lines>
确认：BDB2|<trans_id>|<message_id>|ACK|<command_message_id>
下发：BDB2|<trans_id>|<message_id>|<P1_READY|P2_READY|GO|WIN|LOSE>
```

- `trans_id`：一轮 Battle 的唯一事务 ID。两名玩家 READY 后由 Bot 生成，并通过 GO 命令同步给两台设备。
- `message_id`：状态或命令的唯一消息 ID。重发保持同一个 ID，接收端据此幂等去重。
- READY 每 250ms 重发，直到收到 GO。
- PLAYING 每 500ms 发送同一消息作为低频心跳，保证开始状态和胜负命令丢失时能够快速补发。
- GAME_OVER 每 250ms 重发，直到收到 WIN/LOSE。
- MPY 对 GO/WIN/LOSE 上报 ACK；Bot 在 SQLite 中持久化待确认命令和 ACK 状态。
- Bot 的 push RPC 返回失败时会记录日志，下一次状态重发/心跳会再次发送相同命令 ID。

Bot 使用全新的 `bot/data/battle.sqlite` 保存群聊、用户、设备、slot、游戏状态、结果、事务 ID、消息 ID、待确认命令和 ACK 状态；开发阶段不迁移或兼容旧数据库。

## 配置和运行

需要 Node.js 24 或更高版本：

```powershell
$env:BUBBLE_BOT_TOKEN='...'
$env:BUBBLE_API_BASE_URL='...'
$env:MPS_ID='...'
$env:MPS_VERSION='1.1.1'
npm --prefix webapp install
npm run build
npm run bot
```

可用 `BATTLE_DB_PATH` 修改 SQLite 文件位置，用 `WEBAPP_URL` 指向已部署的 WebApp。
