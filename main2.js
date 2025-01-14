import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import fs from 'fs';
import WebSocket from 'ws';
import crypto from 'crypto';
import log from './utils/logger.js';
import banner from './utils/banner.js';

const headers = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A_Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

// Membaca file secara sinkron
function readFile(pathFile) {
    try {
        const datas = fs.readFileSync(pathFile, 'utf8')
            .split('\n')
            .map(data => data.trim())
            .filter(data => data.length > 0);
        return datas;
    } catch (error) {
        log.error(`Error reading file: ${error.message}`);
        return [];
    }
}

// Membuat HTTP atau SOCKS Proxy Agent
const newAgent = (proxy = null) => {
    if (proxy && proxy.startsWith('http://')) {
        return new HttpsProxyAgent(proxy);
    } else if (proxy && (proxy.startsWith('socks4://') || proxy.startsWith('socks5://'))) {
        return new SocksProxyAgent(proxy);
    }
    return null;
};

// Menguji konektivitas proxy
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

// Mengambil daftar proxy dan memfilter hingga mendapatkan 7 proxy valid
async function fetchSevenValidProxies() {
    try {
        const response = await axios.get(
            'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text'
        );
        const proxies = response.data.split('\n').map(p => `http://${p.trim()}`).filter(p => p);
        log.info(`Total proxies fetched: ${proxies.length}`);

        const validProxies = [];
        for (const proxy of proxies) {
            if (validProxies.length >= 7) break; // Hentikan setelah 7 proxy valid ditemukan
            const isValid = await testProxy(proxy);
            if (isValid) validProxies.push(proxy);
        }

        log.info(`Total valid proxies found: ${validProxies.length}`);
        return validProxies;
    } catch (error) {
        log.error('Error fetching proxies:', error.message || 'unknown error');
        return [];
    }
}

// Generate token untuk akun
async function generateToken(data, proxy) {
    const agent = newAgent(proxy);
    try {
        const response = await axios.post('https://apitn.openledger.xyz/api/v1/auth/generate_token', data, {
            headers: {
                ...headers,
                'Content-Type': 'application/json',
            },
            httpsAgent: agent,
            httpAgent: agent
        });
        return response.data.data;
    } catch (error) {
        return null;
    }
}

// Mengambil informasi pengguna
async function getUserInfo(token, proxy, index) {
    const agent = newAgent(proxy);
    try {
        const response = await axios.get('https://rewardstn.openledger.xyz/api/v1/reward_realtime', {
            headers: {
                ...headers,
                'Authorization': 'Bearer ' + token
            },
            httpsAgent: agent,
            httpAgent: agent
        });
        const { total_heartbeats } = response?.data?.data[0] || { total_heartbeats: '0' };
        log.info(`Account ${index} has gained points today:`, { PointsToday: total_heartbeats });

        return response.data.data;
    } catch (error) {
        if (error.response && error.response.status === 401) {
            log.error('Unauthorized, token is invalid or expired');
            return 'unauthorized';
        };

        log.error('Error fetching user info:', error.message || error);
        return null;
    }
}

// Mengambil detail klaim hadiah
async function getClaimDetails(token, proxy, index) {
    const agent = newAgent(proxy);
    try {
        const response = await axios.get('https://rewardstn.openledger.xyz/api/v1/claim_details', {
            headers: {
                ...headers,
                'Authorization': 'Bearer ' + token
            },
            httpsAgent: agent,
            httpAgent: agent
        });
        const { tier, dailyPoint, claimed, nextClaim = 'Not Claimed' } = response?.data?.data || {};
        log.info(`Details for Account ${index}:`, { tier, dailyPoint, claimed, nextClaim });
        return response.data.data;
    } catch (error) {
        log.error('Error fetching claim info:', error.message || error);
        return null;
    }
}

// Mengklaim hadiah harian
async function claimRewards(token, proxy, index) {
    const agent = newAgent(proxy);
    try {
        const response = await axios.get('https://rewardstn.openledger.xyz/api/v1/claim_reward', {
            headers: {
                ...headers,
                'Authorization': 'Bearer ' + token
            },
            httpsAgent: agent,
            httpAgent: agent
        });
        log.info(`Daily Rewards Claimed for Account ${index}:`, response.data.data);
        return response.data.data;
    } catch (error) {
        log.error('Error claiming daily reward:', error.message || error);
        return null;
    }
}

// Fungsi utama
(async () => {
    log.info(banner);
    const wallets = readFile('wallets.txt');
    if (wallets.length === 0) {
        log.error('No wallets found in wallets.txt');
        return;
    }

    log.info('Fetching and testing proxies...');
    const validProxies = await fetchSevenValidProxies();

    if (validProxies.length < 7) {
        log.error('Failed to find 7 valid proxies.');
        return;
    }

    log.info('7 Valid proxies found. Continuing with the main script...');

    const accountsProcessing = wallets.map(async (address, index) => {
        const proxy = validProxies[index % validProxies.length];
        log.info(`Processing wallet ${index + 1} with proxy: ${proxy}`);

        try {
            const tokenResponse = await generateToken({ address }, proxy);
            if (tokenResponse?.token) {
                log.info(`Successfully logged in with token for wallet ${index + 1}: ${tokenResponse.token}`);
                const claimDaily = await getClaimDetails(tokenResponse.token, proxy, index + 1);
                if (claimDaily && !claimDaily.claimed) {
                    log.info(`Trying to Claim Daily rewards for Account ${index + 1}...`);
                    await claimRewards(tokenResponse.token, proxy, index + 1);
                }
                await getUserInfo(tokenResponse.token, proxy, index + 1);
            } else {
                log.error(`Failed to get token for wallet ${index + 1}`);
            }
        } catch (error) {
            log.error(`Error processing wallet ${index + 1}:`, error.message || 'unknown error');
        }
    });

    await Promise.all(accountsProcessing);
})();
