const fs = require('fs');
const dirs = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
for (const pid of dirs) {
  try {
    const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf-8').replace(/\0/g, ' ').trim();
    if (cmd) console.log(pid + ': ' + cmd);
  } catch {}
}
