// 実画像に対するOCR候補を同じブラウザー内Tesseractで比較する開発用ハーネス。
// 配布ZIPには tools/ を含めないため、製品実行時には読み込まれない。

function benchmarkImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("評価画像を読み込めませんでした。"));
        image.src = dataUrl;
    });
}

function summarizeOcrData(data, orientation) {
    const lines = [];
    forEachOcrLine(data.blocks, (line) => {
        const symbols = [];
        const words = [];
        for (const word of (line.words || [])) {
            words.push({
                text: word.text,
                confidence: word.confidence,
                bbox: word.bbox
            });
            for (const symbol of (word.symbols || [])) {
                symbols.push({
                    text: symbol.text,
                    confidence: symbol.confidence,
                    bbox: symbol.bbox
                });
            }
        }
        lines.push({
            text: symbols.map((symbol) => symbol.text).join(""),
            confidence: line.confidence,
            bbox: line.bbox,
            words,
            symbols
        });
    });
    return {
        confidence: data.confidence,
        text: data.text,
        blockText: buildTextFromBlocks(data.blocks),
        glyphSize: estimateGlyphSizeFromBlocks(data.blocks, orientation),
        lines
    };
}

function maskBenchmarkRedAnnotations(canvas) {
    const context = canvas.getContext("2d");
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;
    for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] > 180 && pixels[i + 1] < 130 && pixels[i + 2] < 130) {
            pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
        }
    }
    context.putImageData(imageData, 0, 0);
}

function padBenchmarkCanvas(source, padding) {
    if (!(padding > 0)) return source;
    const canvas = createOcrCanvas(source.width + padding * 2, source.height + padding * 2);
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, padding, padding);
    return canvas;
}

async function recognizeBenchmarkPass(worker, canvas, orientation) {
    const startedAt = performance.now();
    const result = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const summary = {
        elapsedMs: Math.round(performance.now() - startedAt),
        ...summarizeOcrData(result.data, orientation)
    };
    Object.defineProperty(summary, "data", { value: result.data });
    return summary;
}

function buildHorizontalReflowCanvas(source, verticalData) {
    const lines = [];
    forEachOcrLine(verticalData.blocks, (line) => {
        const text = (line.words || []).flatMap((word) => word.symbols || [])
            .map((symbol) => symbol.text).join("");
        const width = line.bbox?.x1 - line.bbox?.x0;
        const span = line.bbox?.y1 - line.bbox?.y0;
        if (text && width > 0 && span > 0) lines.push({ line, text, width, span });
    });
    if (!lines.length) return null;

    const widths = lines.map((item) => item.width).sort((a, b) => a - b);
    const glyphSize = widths[Math.floor(widths.length / 2)];
    const longRatios = lines.filter((item) => [...item.text].length >= 20)
        .map((item) => item.span / [...item.text].length)
        .sort((a, b) => a - b);
    const nominalPitch = longRatios.length
        ? longRatios[Math.floor((longRatios.length - 1) * 0.75)]
        : glyphSize;
    const counts = lines.map((item) => {
        const recognized = [...item.text].length;
        if (recognized < 20 || !(nominalPitch > 0)) return recognized;
        const physical = Math.round(item.span / nominalPitch);
        return physical > 0 && Math.abs(physical - recognized) <= 2 ? physical : recognized;
    });

    const cell = 48;
    const gap = 12;
    const canvas = createOcrCanvas(Math.max(...counts) * cell, lines.length * (cell + gap));
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    lines.forEach((item, lineIndex) => {
        const count = counts[lineIndex];
        const pitch = item.span / count;
        const sourceWidth = Math.min(source.width, Math.max(glyphSize * 1.35, item.width));
        const sourceX = Math.max(0, Math.min(
            (item.line.bbox.x0 + item.line.bbox.x1 - sourceWidth) / 2,
            source.width - sourceWidth));
        for (let index = 0; index < count; index++) {
            const sourceY = item.line.bbox.y0 + pitch * index;
            const destinationX = index * cell + 4;
            const destinationY = lineIndex * (cell + gap) + 4;
            context.drawImage(source,
                sourceX, sourceY, sourceWidth, pitch,
                destinationX, destinationY, cell - 8, cell - 8);
        }
    });
    return { canvas, counts, nominalPitch, cell, gap };
}

async function recognizeReflowRows(worker, reflow) {
    const startedAt = performance.now();
    const lines = [];
    await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
    for (let index = 0; index < reflow.counts.length; index++) {
        const row = cropOcrCanvas(reflow.canvas, 0, index * (reflow.cell + reflow.gap),
            reflow.counts[index] * reflow.cell, reflow.cell, 1);
        const result = await worker.recognize(row, {}, { text: true, blocks: true });
        lines.push({
            text: (result.data.text || "").replace(/\s+/g, ""),
            confidence: result.data.confidence,
            bbox: { x0: 0, y0: index, x1: reflow.counts[index], y1: index + 1 }
        });
    }
    return {
        elapsedMs: Math.round(performance.now() - startedAt),
        confidence: lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length,
        glyphSize: reflow.cell,
        text: lines.map((line) => line.text).join("\n"),
        lines,
        counts: reflow.counts,
        nominalPitch: reflow.nominalPitch
    };
}

async function runOcrBenchmark({
    dataUrl,
    crop,
    scales = [0.75, 1, 1.25, 1.5, 2, 2.5, 3],
    maskRed = false,
    padding = 0,
    psmModes = [],
    forceOrientation,
    crossLanguages = [],
    verticalReflow = false
}) {
    const image = await benchmarkImageFromDataUrl(dataUrl);
    const rect = crop || { x: 0, y: 0, width: image.width, height: image.height };
    let source = cropToOcrCanvas(image, rect.x, rect.y, rect.width, rect.height);
    if (maskRed) maskBenchmarkRedAnnotations(source);
    source = padBenchmarkCanvas(source, padding);
    const detected = detectTextOrientation(source);
    const orientation = forceOrientation || detected.orientation;
    const lang = orientation === "vertical" ? "jpn_vert" : "jpn";
    const pool = createOcrWorkerPool();
    const worker = await pool.get(lang);
    const passes = {};
    let verticalBaseData = null;
    try {
        const gray = toGrayscale(source);
        for (const scale of scales) {
            const canvas = scale === 1 ? gray : upscaleOcrCanvas(gray, scale);
            passes[`gray-${scale}`] = await recognizeBenchmarkPass(worker, canvas, orientation);
            if (scale === 1) verticalBaseData = passes[`gray-${scale}`].data;
        }
        const prepared = prepareOcrCanvas(source);
        if (prepared !== source) {
            passes.binary = await recognizeBenchmarkPass(worker, prepared, orientation);
        }
        for (const psm of psmModes) {
            await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
            passes[`psm-${psm}`] = await recognizeBenchmarkPass(worker, gray, orientation);
        }
        if (lang === "jpn_vert" && psmModes.length) {
            await worker.setParameters({
                tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK_VERT_TEXT
            });
        }
        for (const crossLang of crossLanguages) {
            const crossWorker = await pool.get(crossLang);
            await crossWorker.setParameters({
                tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK_VERT_TEXT
            });
            passes[`lang-${crossLang}`] = await recognizeBenchmarkPass(
                crossWorker, gray, orientation);
        }
        if (verticalReflow && orientation === "vertical" && verticalBaseData) {
            const reflow = buildHorizontalReflowCanvas(gray, verticalBaseData);
            if (reflow) {
                const horizontalWorker = await pool.get("jpn");
                await horizontalWorker.setParameters({
                    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK
                });
                passes.reflow = await recognizeBenchmarkPass(
                    horizontalWorker, reflow.canvas, "horizontal");
                passes.reflow.counts = reflow.counts;
                passes.reflow.nominalPitch = reflow.nominalPitch;
                passes["reflow-rows"] = await recognizeReflowRows(horizontalWorker, reflow);
            }
        }
        const startedAt = performance.now();
        const production = await recognizeWithOrientation(source, pool.get);
        return {
            image: { width: image.width, height: image.height },
            crop: rect,
            detected,
            passes,
            production: {
                elapsedMs: Math.round(performance.now() - startedAt),
                ...production,
                normalized: cleanForSpeech(normalizeOcrText(production.text))
            }
        };
    } finally {
        pool.terminate();
    }
}

globalThis.runOcrBenchmark = runOcrBenchmark;
