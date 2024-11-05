const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');
const cors = require('cors');
const app = express();

puppeteer.use(StealthPlugin());
puppeteer.use(
  RecaptchaPlugin({
    provider: {
      id: '2captcha',
      token: process.env.CAPTCHA_KEY
    }
  })
);

app.use(cors());
app.use(express.json());

class AutomationService {
    constructor() {
        this.browser = null;
        this.page = null;
        this.processedElements = new Set();
    }

    async initBrowser() {
        this.browser = await puppeteer.launch({
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ],
            headless: 'new'
        });
    }

    async createPage() {
        this.page = await this.browser.newPage();
        await this.page.setDefaultNavigationTimeout(60000);
        await this.page.setViewport({ width: 1280, height: 800 });
        
        this.page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        this.page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
        this.page.on('requestfailed', req => console.log('REQUEST FAILED:', req.url()));
    }

    async injectAutomationCode() {
        await this.page.evaluate(() => {
            window.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            
            window.getRandomDelay = (min, max) => {
                return Math.floor(Math.random() * (max - min + 1) + min);
            };

            window.interactionMethods = [
                async (element) => {
                    const props = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onpointerup'];
                    for (const prop of props) {
                        if (element[prop]) {
                            element[prop]();
                            await window.sleep(100);
                        }
                    }
                    element.click();
                },
                async (element) => {
                    const events = [
                        new MouseEvent('mouseover', {bubbles: true}),
                        new MouseEvent('mouseenter', {bubbles: true}),
                        new MouseEvent('pointerdown', {bubbles: true}),
                        new MouseEvent('mousedown', {bubbles: true}),
                        new MouseEvent('pointerup', {bubbles: true}),
                        new MouseEvent('mouseup', {bubbles: true}),
                        new MouseEvent('click', {bubbles: true})
                    ];
                    for (const event of events) {
                        element.dispatchEvent(event);
                        await window.sleep(50);
                    }
                },
                async (element) => {
                    element.focus();
                    await window.sleep(100);
                    element.click();
                    await window.sleep(100);
                    element.blur();
                }
            ];

            window.findClickableElements = () => {
                const selectors = [
                    'button',
                    '[role="button"]',
                    'a',
                    'input[type="submit"]',
                    '[class*="btn"]',
                    '[class*="continue"]',
                    '[class*="verify"]',
                    '[class*="task"]',
                    '[class*="next"]',
                    '[data-testid*="continue"]',
                    '[data-testid*="next"]'
                ];

                return [...document.querySelectorAll(selectors.join(','))].filter(el => {
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return el.offsetParent !== null &&
                           !el.disabled &&
                           style.display !== 'none' &&
                           style.visibility !== 'hidden' &&
                           parseFloat(style.opacity) > 0 &&
                           rect.width > 0 &&
                           rect.height > 0;
                });
            };

            window.processElement = async (element) => {
                for (const method of window.interactionMethods) {
                    try {
                        await method(element);
                        await window.sleep(window.getRandomDelay(500, 1000));
                        return true;
                    } catch (err) {
                        continue;
                    }
                }
                return false;
            };
        });
    }

    async handleCaptchas() {
        try {
            const {solved, error} = await this.page.solveRecaptchas();
            
            if (solved) {
                console.log('CAPTCHA resuelto:', solved);
                await this.page.waitForTimeout(1000);
            }
            
            const frames = this.page.frames();
            for (const frame of frames) {
                const checkbox = await frame.$('div.recaptcha-checkbox-border');
                if (checkbox) {
                    await frame.click('div.recaptcha-checkbox-border');
                    console.log('Click en checkbox de CAPTCHA');
                    await this.page.waitForTimeout(2000);
                }
            }
        } catch (err) {
            console.log('Error en manejo de CAPTCHA:', err.message);
        }
    }

    async processPage() {
        return await this.page.evaluate(async () => {
            const elements = window.findClickableElements();
            console.log(`Encontrados ${elements.length} elementos clickeables`);
            
            for (const element of elements) {
                try {
                    console.log('Procesando elemento:', element.textContent || element.className);
                    await window.processElement(element);
                    await window.sleep(window.getRandomDelay(1000, 2000));
                } catch (err) {
                    console.log('Error procesando elemento:', err.message);
                }
            }
        });
    }

    async cleanup() {
        if (this.page) await this.page.close();
        if (this.browser) await this.browser.close();
    }
}

app.get('/process', async (req, res) => {
    const { url } = req.query;
    const service = new AutomationService();
    
    if (!url) {
        return res.status(400).json({ error: 'URL requerida' });
    }

    console.log('Procesando URL:', url);
    
    try {
        await service.initBrowser();
        await service.createPage();
        await service.injectAutomationCode();
        
        console.log('Navegando a la URL...');
        await service.page.goto(url, { waitUntil: 'networkidle0' });
        console.log('Página cargada');
        
        await service.handleCaptchas();
        
        let attempts = 0;
        const maxAttempts = 5;
        
        while (attempts < maxAttempts) {
            console.log(`Intento ${attempts + 1} de ${maxAttempts}`);
            await service.processPage();
            await service.page.waitForTimeout(2000);
            attempts++;
            
            await service.handleCaptchas();
            
            const newUrl = service.page.url();
            console.log('URL actual:', newUrl);
            
            if (newUrl !== url) {
                console.log('Detectada redirección, siguiendo...');
                await service.page.waitForTimeout(2000);
            }
        }
        
        res.json({ success: true, message: 'Proceso completado' });
    } catch (error) {
        console.error('Error en proceso:', error);
        res.status(500).json({ error: error.message });
    } finally {
        await service.cleanup();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
