'use strict';
// 远程执行单条命令并打印输出。密码从 .pwd 文件读取（避免 shell 转义）。
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const HOST = '47.93.38.162';
const USER = process.env.DEPLOY_USER || 'root';
const PWD_FILE = path.join(__dirname, '.pwd');
const PWD = fs.existsSync(PWD_FILE) ? fs.readFileSync(PWD_FILE, 'utf8').replace(/[\r\n]+$/, '') : process.env.DEPLOY_PWD;
const CMD = process.argv[2];

if (!PWD) { console.error('缺少密码(.pwd 文件或 DEPLOY_PWD)'); process.exit(2); }
if (!CMD) { console.error('缺少命令参数'); process.exit(2); }

const conn = new Client();
conn.on('ready', () => {
  conn.exec(CMD, { pty: true }, (err, stream) => {
    if (err) { console.error('EXEC_ERR', err.message); conn.end(); process.exit(1); }
    let out = '';
    stream.on('close', (code) => {
      process.stdout.write(out);
      console.log('\n__EXIT_CODE__=' + code);
      conn.end();
      process.exit(code || 0);
    }).on('data', (d) => { out += d.toString(); })
      .stderr.on('data', (d) => { out += d.toString(); });
  });
}).on('error', (e) => {
  console.error('CONN_ERR', e.message);
  process.exit(1);
}).on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
  finish(prompts.map(() => PWD));
}).connect({ host: HOST, port: 22, username: USER, password: PWD, tryKeyboard: true, readyTimeout: 20000 });
