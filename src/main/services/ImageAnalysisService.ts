
// @ts-ignore — moduleResolution mismatch with @gutenye/ocr-node
import Ocr from '@gutenye/ocr-node';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class ImageAnalysisService {
    private ocr: any = null;
    private ocrReady: Promise<any> | null = null;

    /**
     * Get or create a persistent PaddleOCR instance.
     * Model is loaded ONCE, then reused for all subsequent calls.
     */
    private getOcr(): Promise<any> {
        if (!this.ocrReady) {
            this.ocrReady = (async () => {
                console.log('[OCR] Initializing PaddleOCR engine (one-time)...');
                const ocr = await Ocr.create();
                this.ocr = ocr;
                console.log('[OCR] PaddleOCR ready ✅');
                return ocr;
            })();
        }
        return this.ocrReady;
    }

    /**
     * Save buffer to a temp file for PaddleOCR (it requires a file path).
     */
    private async saveTempImage(buffer: Buffer): Promise<string> {
        const tmpDir = os.tmpdir();
        const tmpFile = path.join(tmpDir, `ocr_${Date.now()}.png`);

        // Preprocess with sharp: grayscale + normalize for better OCR
        const processed = await sharp(buffer)
            .resize(800, null, { withoutEnlargement: true })
            .grayscale()
            .normalize()
            .png()
            .toBuffer();

        await fs.promises.writeFile(tmpFile, processed);
        return tmpFile;
    }

    async analyzeImage(imageSource: string | Buffer): Promise<boolean> {
        if (!imageSource) return false;

        const sourceLog = typeof imageSource === 'string' ? imageSource.substring(0, 60) : 'Buffer Image';
        console.log(`[OCR] Analyzing: ${sourceLog}...`);

        let tmpFile = '';
        try {
            const ocr = await this.getOcr();

            // Prepare image file path
            if (Buffer.isBuffer(imageSource)) {
                tmpFile = await this.saveTempImage(imageSource);
            } else if (imageSource.startsWith('http')) {
                // Download URL to buffer, then save
                const response = await fetch(imageSource);
                if (!response.ok) {
                    console.log(`[OCR] Download failed (${response.status}), skipping.`);
                    return false;
                }
                const buffer = Buffer.from(await response.arrayBuffer());
                tmpFile = await this.saveTempImage(buffer);
            } else {
                // Assume it's a file path
                tmpFile = imageSource;
            }

            // Run PaddleOCR
            const startTime = Date.now();
            const lines = await ocr.detect(tmpFile);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            if (!lines || lines.length === 0) {
                console.log(`[OCR] Done in ${elapsed}s — no text detected.`);
                return false;
            }

            // Combine all detected text
            const allText = lines.map((l: any) => l.text).join(' ').toLowerCase();
            const avgScore = (lines.reduce((sum: number, l: any) => sum + l.score, 0) / lines.length * 100).toFixed(0);
            console.log(`[OCR] Done in ${elapsed}s (avg confidence: ${avgScore}%, ${lines.length} lines): "${allText.substring(0, 120)}"`);

            // Match targets
            const targetPhone = '081223143330';
            const cleanText = allText.replace(/\s+/g, '').replace(/-/g, '');

            const raffaPatterns = ['raffa', 'rafia', 'rafa', 'raffacomputer', 'rafacomputer', 'raffac'];
            for (const pattern of raffaPatterns) {
                if (allText.includes(pattern)) {
                    console.log(`✅ [OCR] Match: "${pattern}"`);
                    return true;
                }
            }

            if (cleanText.includes(targetPhone)) {
                console.log(`✅ [OCR] Match: Phone ${targetPhone}`);
                return true;
            }

            if ((allText.includes('computer') || allText.includes('komputer')) && (allText.includes('raf') || allText.includes('rafa'))) {
                console.log('✅ [OCR] Match: Raffa (Fuzzy)');
                return true;
            }

            console.log(`❌ [OCR] No match.`);
            return false;

        } catch (error: any) {
            console.error(`❌ [OCR] Error: ${error.message}`);
            return false;
        } finally {
            // Cleanup temp file
            if (tmpFile && tmpFile.includes(os.tmpdir())) {
                try { await fs.promises.unlink(tmpFile); } catch { }
            }
        }
    }

    async terminate(): Promise<void> {
        this.ocr = null;
        this.ocrReady = null;
        console.log('[OCR] PaddleOCR instance released.');
    }
}
