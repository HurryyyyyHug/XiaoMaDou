# 🃏 斗地主 · 在线对战

多人网页斗地主,适配**手机端 / 电脑端**。固定账号登录后开玩。

## 功能
- **账号登录**:9 个固定账号,密码为「账号+621」(如 `fyb` → `fyb621`)。账号:`sjb mzs fyb lgr zh ylw zy wsq lxy`。
- **公平发牌**:使用 `crypto.randomInt` 的无偏 Fisher-Yates 洗牌(加密安全随机数),发牌完全随机公平。
- **叫地主**:1 / 2 / 3 分定底分,最高分者当地主并拿 3 张底牌。
- **完整牌型**:单张、对子、三张、三带一、三带二、单顺、连对、飞机(带单/带对)、四带二、炸弹、王炸。
- **翻倍规则**:每个炸弹 / 王炸 ×2;春天(农民一张未出)/ 反春天(地主只出一手)再 ×2。
- **按房间计分**:`底分 × 倍数` 为一家分值,地主输赢按 2 倍结算(1 打 2)。**每次开房,房内总分从 0 开始累计**。
- **出牌计时**:每人每回合 30 秒倒计时;超时自动跳过(自由出牌则自动出最小单张)。若服务端判断该玩家**无牌可压上家**,实际只给 5 秒就自动跳过(界面仍显示 30 秒)。
- **多房间 + 观战 + 断线重连**(刷新页面用本地保存的账号自动重连)。

## 本地运行

```bash
npm install
npm start            # 默认端口 3000,打开 http://localhost:3000
PORT=8080 npm start  # 或指定端口
```

> **改完代码需要重启服务**:Node 不会自动热更新。手动 `Ctrl+C` 再 `npm start`,
> 或用自动重启:`node --watch server.js`(改动 server.js / gameLogic.js 自动重启;
> `public/` 下的前端文件改完刷新浏览器即可,不必重启)。

## 放到公网(cloudflared 内网穿透)

用 Cloudflare Tunnel,不需要公网 IP、不用配路由器,临时链接还免费。

### 1. 下载 cloudflared

```bash
# Linux x86_64
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x cloudflared-linux-amd64
```
> macOS:`brew install cloudflared`;Windows 到 release 页下载 exe。

### 2. 先启动游戏服务

```bash
PORT=8080 npm start
```

### 3. 开隧道(另开一个终端)

```bash
./cloudflared-linux-amd64 tunnel --url http://localhost:8080
```

启动后会打印一个形如 `https://xxxx-xxxx.trycloudflare.com` 的公网地址,把它发给朋友就能一起玩。
**注意**:`--url` 的端口必须和 `PORT` 一致(这里都是 8080)。

> 临时隧道每次重启地址会变。想要**固定域名**,可登录 Cloudflare 后用
> `cloudflared tunnel login` → `cloudflared tunnel create ddz` → 在 DNS 里绑定你自己的域名 →
> `cloudflared tunnel run`,即可用固定的 `https://你的域名` 访问。

## 玩法说明
1. 进入大厅 → 「快速开始」自动坐进有空位的房间(或「创建房间」)。
2. 三人到齐,各自点「准备」即开局发牌。
3. 轮流叫分(不叫 / 1 / 2 / 3),产生地主。
4. 地主先出,点选手牌再「出牌」,压不过就「不要」。
5. 谁先出完牌,该方获胜,自动结算分数,点「下一局」继续。

## 文件结构
```
server.js       Express + Socket.IO 服务端、房间与游戏流程
gameLogic.js    牌型识别 / 比较 / 洗牌发牌(纯函数)
public/
  index.html    页面结构
  style.css     响应式样式(手机/电脑)
  client.js     前端交互
```
