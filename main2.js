import axios from 'axios';
import axiosRetry from 'axios-retry';
import WebSocket from 'ws';
import crypto from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import fs from 'fs';
import banner from './utils/banner.js';
import log from './utils/logger.js';

const headers = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A_Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

const newAgent = (proxy = null) => {
    if (proxy && proxy.startsWith('http://')) {
        return new HttpsProxyAgent(proxy);
    } else if (proxy && (proxy.startsWith('socks4://') || proxy.startsWith('socks5://'))) {
        return new SocksProxyAgent(proxy);
    }
    return null;
};

// Fungsi untuk menguji koneksi proxy
async function testProxy(proxy) {
    const agent = newAgent(proxy);
    try {
        await axios.get('https://www.google.com', { httpsAgent: agent, timeout: 5000 });
        log.info(`Proxy valid: ${proxy}`);
        return true;
    } catch (error) {
        log.warn(`Proxy invalid: ${proxy}`);
        return false;
    }
}

// Ambil daftar proxy dari URL dan filter hanya yang valid
async function fetchValidProxies() {
    try {
        const response = await axios.get(
            'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text'
        );
        const proxies = response.data.split('\n').map(p => p.trim()).filter(p => p);
        log.info(`Total proxies fetched: ${proxies.length}`);

        // Uji konektivitas proxy
        const validProxies = [];
        for (const proxy of proxies) {
            const isValid = await testProxy(proxy);
            if (isValid) validProxies.push(proxy);
        }
        log.info(`Total valid proxies: ${validProxies.length}`);
        return validProxies;
    } catch (error) {
        log.error('Error fetching proxies:', error.message || 'unknown error');
        return [];
    }
}

// Main function
const main = async () => {
    log.info(banner);

    const wallets = fs.readFileSync('wallets.txt', 'utf8')
        .split('\n')
        .map(w => w.trim())
        .filter(w => w);

    if (wallets.length === 0) {
        log.error('No wallets found in wallets.txt');
        return;
    }

    const proxies = await fetchValidProxies();
    if (proxies.length === 0) {
        log.error('No valid proxies available');
        return;
    }

    log.info(`Starting program for all accounts:`, wallets.length);

    const accountsProcessing = wallets.map(async (address, index) => {
        const proxy = proxies[index % proxies.length];
        log.info(`Processing Account ${index + 1} with proxy: ${proxy}`);
        let isConnected = false;


        log.info(`Processing Account ${index + 1} with proxy: ${proxy || 'No proxy'}`);

        let claimDetailsInterval;
        let userInfoInterval;


        while (!isConnected) {
            try {
                let response = await generateToken({ address }, proxy);
                while (!response || !response.token) {
                    log.error(`Failed to generate token for account ${index} retrying...`)
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    response = await generateToken({ address }, proxy);
                }

                const token = response.token;

                log.info(`login success for Account ${index + 1}:`, token.slice(0, 36) + "-" + token.slice(-24));
                log.info(`Getting user info and claim details for account ${index + 1}...`);
                const claimDaily = await getClaimDetails(token, proxy, index + 1);
                if (claimDaily && !claimDaily.claimed) {
                    log.info(`Trying to Claim Daily rewards for Account ${index + 1}...`);
                    await claimRewards(token, proxy, index + 1);
                }
                await getUserInfo(token, proxy, index + 1)

                const socket = new WebSocketClient(token, address, proxy, index + 1);
                socket.connect();
                isConnected = true;

                userInfoInterval = setInterval(async () => {
                    log.info(`Fetching total points gained today for account ${index + 1}...`);
                    const user = await getUserInfo(token, proxy, index + 1);

                    if (user === 'unauthorized') {
                        log.info(`Unauthorized: Token is invalid or expired for account ${index + 1}, reconnecting...`);

                        isConnected = false;
                        socket.close();
                        clearInterval(userInfoInterval);
                        clearInterval(claimDetailsInterval);
                    }
                }, 9 * 60 * 1000); // change to 9 minutes to prevent error 429 when claim daily reward.

                claimDetailsInterval = setInterval(async () => {
                    try {
                        log.info(`Checking Daily Rewards for Account ${index + 1}...`)
                        const claimDetails = await getClaimDetails(token, proxy, index + 1);

                        if (claimDetails && !claimDetails.claimed) {
                            log.info(`Trying to Claim Daily rewards for Account ${index + 1}...`);
                            await claimRewards(token, proxy, index + 1);
                        }
                    } catch (error) {
                        log.error(`Error fetching claim details for Account ${index + 1}: ${error.message || 'unknown error'}`);
                    }
                }, 60 * 60 * 1000); // Fetch claim details every 60 minutes

            } catch (error) {
                log.error(`Failed to start WebSocket client for Account ${index + 1}:`, error.message || 'unknown error');
                isConnected = false;

                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        process.on('SIGINT', () => {
            log.warn(`Process received SIGINT, cleaning up and exiting program...`);
            clearInterval(claimDetailsInterval);
            clearInterval(userInfoInterval);
            process.exit(0);
        });

        process.on('SIGTERM', () => {
            log.warn(`Process received SIGTERM, cleaning up and exiting program...`);
            clearInterval(claimDetailsInterval);
            clearInterval(userInfoInterval);
            process.exit(0);
        });

    });

    await Promise.all(accountsProcessing);
};

//run
main();
