import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIpconfigDns, parseResolvConf } from "../quickjs/runtime/node-dns.js";

test("parseIpconfigDns handles Windows XP and 7 English outputs", () => {
	const xp = `
Windows IP Configuration

        Host Name . . . . . . . . . . . . : WINXP-VM
        Primary Dns Suffix  . . . . . . . : 
        Node Type . . . . . . . . . . . . : Unknown
        IP Routing Enabled. . . . . . . . : No
        WINS Proxy Enabled. . . . . . . . : No

Ethernet adapter Local Area Connection:

        Connection-specific DNS Suffix  . : local
        Description . . . . . . . . . . . : Intel(R) PRO/1000 MT Network Connection
        Physical Address. . . . . . . . . : 08-00-27-88-99-AA
        Dhcp Enabled. . . . . . . . . . . : Yes
        Autoconfiguration Enabled . . . . : Yes
        IP Address. . . . . . . . . . . . : 192.168.1.150
        Subnet Mask . . . . . . . . . . . : 255.255.255.0
        Default Gateway . . . . . . . . . : 192.168.1.1
        DHCP Server . . . . . . . . . . . : 192.168.1.1
        DNS Servers . . . . . . . . . . . : 192.168.1.1
                                            192.168.1.2
        Primary WINS Server . . . . . . . : 10.0.0.1
        Lease Obtained. . . . . . . . . . : Monday, September 21, 2026 10:00:00 AM
        Lease Expires . . . . . . . . . . : Tuesday, September 22, 2026 10:00:00 AM
`;
	assert.deepEqual(parseIpconfigDns(xp), ["192.168.1.1", "192.168.1.2"]);

	const win7 = `
Windows IP Configuration

   Host Name . . . . . . . . . . . . : Win7-PC
   Primary Dns Suffix  . . . . . . . : 
   Node Type . . . . . . . . . . . . : Hybrid
   IP Routing Enabled. . . . . . . . : No
   WINS Proxy Enabled. . . . . . . . : No

Ethernet adapter Local Area Connection:

   Connection-specific DNS Suffix  . : lan
   Description . . . . . . . . . . . : Realtek PCIe GBE Family Controller
   Physical Address. . . . . . . . . : 00-1A-2B-3C-4D-5E
   DHCP Enabled. . . . . . . . . . . : Yes
   Autoconfiguration Enabled . . . . : Yes
   IPv4 Address. . . . . . . . . . . : 10.0.2.15(Preferred) 
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . : 10.0.2.2
   DHCP Server . . . . . . . . . . . : 10.0.2.2
   DNS Servers . . . . . . . . . . . : 10.0.2.3
                                       8.8.8.8
                                       8.8.4.4
   NetBIOS over Tcpip. . . . . . . . : Enabled
`;
	assert.deepEqual(parseIpconfigDns(win7), ["10.0.2.3", "8.8.8.8", "8.8.4.4"]);
});

test("parseIpconfigDns handles localized Windows outputs", () => {
	// Spanish
	const es = `
Configuración IP de Windows

Adaptador de Ethernet Conexión de área local:

   Sufijo DNS específico para la conexión. . : mi-red
   Vínculo: dirección IPv6 local. . . : fe80::d4a8:6431:d2d8:d9c3%11
   Dirección IPv4. . . . . . . . . . . . . . : 192.168.0.50
   Máscara de subred . . . . . . . . . . . . : 255.255.255.0
   Puerta de enlace predeterminada . . . . . : 192.168.0.1
   Servidores DNS. . . . . . . . . . . . . . : 192.168.0.1
                                               1.1.1.1
`;
	assert.deepEqual(parseIpconfigDns(es), ["192.168.0.1", "1.1.1.1"]);

	// German
	const de = `
Windows-IP-Konfiguration

Ethernet-Adapter LAN-Verbindung:

   Verbindungsspezifisches DNS-Suffix: fritz.box
   IPv4-Adresse  . . . . . . . . . . : 192.168.178.20
   Subnetzmaske  . . . . . . . . . . : 255.255.255.0
   Standardgateway . . . . . . . . . : 192.168.178.1
   DNS-Server  . . . . . . . . . . . : 192.168.178.1
                                       192.168.178.2
`;
	assert.deepEqual(parseIpconfigDns(de), ["192.168.178.1", "192.168.178.2"]);

	// French
	const fr = `
Configuration IP de Windows

Carte Ethernet Connexion au réseau local :

   Suffixe DNS propre à la connexion. . . : home
   Adresse IPv4. . . . . . . . . . . : 192.168.1.42
   Masque de sous-réseau. . . . . . . . . . : 255.255.255.0
   Passerelle par défaut. . . . . . . . . . : 192.168.1.254
   Serveurs DNS. . . . . . . . . . . . . : 192.168.1.254
`;
	assert.deepEqual(parseIpconfigDns(fr), ["192.168.1.254"]);

	// Chinese
	const zh = `
Windows IP 配置

以太网适配器 以太网:

   连接特定的 DNS 后缀 . . . . . . . : lan
   本地链接 IPv6 地址. . . . . . . . : fe80::591:d933:e3b0:14aa%4
   IPv4 地址 . . . . . . . . . . . . : 192.168.31.100
   子网掩码  . . . . . . . . . . . . : 255.255.255.0
   默认网关. . . . . . . . . . . . . : 192.168.31.1
   DNS 服务器  . . . . . . . . . . . : 114.114.114.114
                                       8.8.8.8
`;
	assert.deepEqual(parseIpconfigDns(zh), ["114.114.114.114", "8.8.8.8"]);
});

test("parseIpconfigDns handles IPv6 and scope IDs", () => {
	const ipv6Output = `
Windows IP Configuration

Ethernet adapter vEth:

   Connection-specific DNS Suffix  . : corp.example.com
   DNS Servers . . . . . . . . . . . : 2001:4860:4860::8888
                                       2001:4860:4860::8844%1
                                       192.168.1.1
`;
	assert.deepEqual(parseIpconfigDns(ipv6Output), ["2001:4860:4860::8888", "2001:4860:4860::8844", "192.168.1.1"]);
});

test("parseResolvConf handles POSIX /etc/resolv.conf", () => {
	const conf = `
# Dynamic resolv.conf file for glibc resolver
; Alternate comment style
nameserver 127.0.0.53
nameserver 1.1.1.1
nameserver 2606:4700:4700::1111%eth0
search home.arpa
options edns0
`;
	assert.deepEqual(parseResolvConf(conf), ["127.0.0.53", "1.1.1.1", "2606:4700:4700::1111"]);
});
