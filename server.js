// server.js —— 应用入口:初始化服务、静态资源和 Socket 事件
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { PORT, PUBLIC_DIR } from './src/config.js';
import { initUsers } from './src/db/users.js';
import { registerSocketHandlers } from './src/socket/handlers.js';

initUsers();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(PUBLIC_DIR));
registerSocketHandlers(io);

httpServer.listen(PORT, () => {
  console.log(`斗地主服务已启动: http://localhost:${PORT}`);
});
