import net from "net";
import makeMdns, { MulticastDNS } from "multicast-dns";

const mdnsServices = (() => {
	const result = [] as MulticastDNS[];
	for(let i = 0; `MDNS_${i}_INTERFACE` in process.env && `MDNS_${i}_IP` in process.env; i++) {
		const mdnsInterface = process.env[`MDNS_${i}_INTERFACE`]!;
		const mdnsIp = process.env[`MDNS_${i}_IP`]!;
		if(net.isIPv4(mdnsInterface) && net.isIPv4(mdnsIp)) {
			result.push(makeMdns({
				type: "udp4",
				interface: mdnsInterface,
				ip: mdnsIp
			}));
		}
		if(net.isIPv6(mdnsInterface) && net.isIPv6(mdnsIp)) {
			result.push(makeMdns({
				type: "udp6",
				interface: mdnsInterface,
				ip: mdnsIp
			}));
		}
	}
	return result;
})();

mdnsServices[0].addListener("response", e => {
	
});
