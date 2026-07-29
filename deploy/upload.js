'use strict';
// SFTP 上传本地文件到远程路径。用法: node upload.js <local> <remote>
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const HOST = '47.93.38.162';
const USER = process.env.DEPLOY_USER || 'root';
const PWD_FILE = path.join(__dirname, '.pwd');
const PWD = fs.existsSync(PWD_FILE) ? fs.readFileSync(PWD_FILE, 'utf8').replace(/[\r\n]+$/, '') : process.env.DEPLOY_PWD;

const local = process.argv[2];
const remote = process.argv[3];
if (!PWD || !local || !remote) { console.error('用法: node upload.js <local> <remote> (需 .pwd)'); process.exit(2); }

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) { console.error('SFTP_ERR', err.message); conn.end(); process.exit(1); }
    sftp.fastPut(local, remote, (e) => {
      if (e) { console.error('PUT_ERR', e.message); conn.end(); process.exit(1); }
      console.log('UPLOADED ' + path.basename(local) + ' -> ' + remote);
      conn.end();
      process.exit(0);
    });
  });
}).on('error', (e) => { console.error('CONN_ERR', e.message); process.exit(1); })
  .on('keyboard-interactive', (n, i, l, p, finish) => finish(p.map(() => PWD)))
  .connect({ host: HOST, port: 22, username: USER, password: PWD, tryKeyboard: true, readyTimeout: 20000 });
