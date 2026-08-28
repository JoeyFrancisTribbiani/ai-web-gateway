import paramiko, time

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('116.204.124.131', username='root', password='Liu131313', timeout=15)

def run(cmd, timeout=30):
    print(f'>>> {cmd[:80]}')
    _, o, _ = ssh.exec_command(cmd, timeout=timeout)
    print(o.read().decode().strip())
    print()

# Check x11vnc process
run('docker exec ai-web-agent sh -c "cat /proc/*/cmdline 2>/dev/null | tr \'\\0\' \'\\n\' | grep x11vnc"')

# RFB handshake test
rfb_script = '''const net = require("net");
const s = net.connect(5900, "agent");
s.on("connect", () => console.log("TCP connected"));
s.on("data", d => { console.log("RFB greeting:", d.toString().substring(0, 20)); s.destroy(); process.exit(0); });
s.on("error", e => { console.log("ERR:", e.message); process.exit(1); });
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 5000);
'''

sftp = ssh.open_sftp()
with sftp.open('/tmp/rfb2.cjs', 'w') as f:
    f.write(rfb_script)
sftp.close()

run('docker cp /tmp/rfb2.cjs ai-web-gateway:/app/rfb2.cjs && docker exec -w /app ai-web-gateway node rfb2.cjs 2>&1')

# Check gateway logs for the VNC open
run('docker logs ai-web-gateway --tail 5 2>&1')

ssh.close()
