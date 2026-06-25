'use strict';

const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Límites por tipo de archivo ──────────────────────────────────────────────
const LIMITS = {
  image: 100 * 1024 * 1024,  // 100 MB
  pdf:   500 * 1024 * 1024,  // 500 MB
  doc:   200 * 1024 * 1024,  // 200 MB
};

// ─── Directorios temporales ───────────────────────────────────────────────────
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ─── Seguridad ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Demasiadas solicitudes. Intentá en unos minutos.' }
});
app.use('/api/', limiter);

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // tope global 500 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif',
      '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods'
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`Formato no permitido: ${ext}`));
  }
});

// ─── Middleware: límite por tipo ──────────────────────────────────────────────
function checkSize(maxBytes) {
  return (req, res, next) => {
    const files = req.files || (req.file ? [req.file] : []);
    const oversized = files.find(f => f.size > maxBytes);
    if (oversized) {
      files.forEach(f => fsp.unlink(f.path).catch(() => {}));
      const mb = Math.round(maxBytes / 1024 / 1024);
      return res.status(413).json({ error: `El archivo supera el límite de ${mb} MB para esta herramienta` });
    }
    next();
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function cleanupFiles(...files) {
  for (const f of files) {
    if (f) try { await fsp.unlink(f); } catch (_) {}
  }
}

function scheduleCleanup(filepath, delayMs = 10 * 60 * 1000) {
  setTimeout(() => cleanupFiles(filepath), delayMs);
}

function getGhostscriptPreset(level) {
  if (level >= 80) return '/printer';
  if (level >= 50) return '/ebook';
  return '/screen';
}

async function compressPDFwithGS(inputPath, outputPath, qualityLevel = 72) {
  const preset = getGhostscriptPreset(qualityLevel);
  try {
    await execFileAsync('gs', [
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      `-dPDFSETTINGS=${preset}`,
      '-dNOPAUSE', '-dQUIET', '-dBATCH',
      `-sOutputFile=${outputPath}`,
      inputPath
    ], { timeout: 5 * 60 * 1000 }); // 5 min timeout para archivos grandes
    return true;
  } catch (_) {
    return false;
  }
}

// ─── Progreso de subida ───────────────────────────────────────────────────────
// El frontend usa XMLHttpRequest con onprogress para mostrar la barra.
// Este endpoint SSE permite trackear el procesamiento server-side.
const progressClients = new Map();

app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  progressClients.set(jobId, res);

  req.on('close', () => {
    progressClients.delete(jobId);
  });
});

function sendProgress(jobId, percent, message) {
  const client = progressClients.get(jobId);
  if (client) {
    client.write(`data: ${JSON.stringify({ percent, message })}\n\n`);
    if (percent >= 100) {
      progressClients.delete(jobId);
    }
  }
}

// ─── Detección de idioma ──────────────────────────────────────────────────────
app.get('/api/detect-lang', (req, res) => {
  const acceptLang = req.headers['accept-language'] || '';
  let lang = 'en';
  if (acceptLang.toLowerCase().startsWith('es')) lang = 'es';
  else if (acceptLang.toLowerCase().startsWith('pt')) lang = 'pt';
  res.json({ lang });
});

// ─── COMPRIMIR PDF ────────────────────────────────────────────────────────────
app.post('/api/pdf/compress', upload.single('file'), checkSize(LIMITS.pdf), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  const inputPath = req.file.path;
  const outputPath = path.join(TMP_DIR, `compressed-${uuidv4()}.pdf`);
  const quality = parseInt(req.body.quality) || 72;
  const jobId = req.body.jobId;

  try {
    if (jobId) sendProgress(jobId, 10, 'Procesando...');

    const gsOk = await compressPDFwithGS(inputPath, outputPath, quality);

    if (!gsOk) {
      if (jobId) sendProgress(jobId, 40, 'Optimizando estructura...');
      const pdfBytes = await fsp.readFile(inputPath);
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      pdfDoc.setTitle('');
      pdfDoc.setAuthor('');
      pdfDoc.setSubject('');
      pdfDoc.setKeywords([]);
      pdfDoc.setProducer('todoarchivos.com');
      pdfDoc.setCreator('todoarchivos.com');
      const compressed = await pdfDoc.save({ useObjectStreams: true });
      await fsp.writeFile(outputPath, compressed);
    }

    const [inputStat, outputStat] = await Promise.all([
      fsp.stat(inputPath),
      fsp.stat(outputPath)
    ]);

    const savedPercent = Math.max(0, Math.round(((inputStat.size - outputStat.size) / inputStat.size) * 100));

    scheduleCleanup(inputPath);
    scheduleCleanup(outputPath);

    if (jobId) sendProgress(jobId, 100, 'Listo');

    res.json({
      success: true,
      originalSize: inputStat.size,
      compressedSize: outputStat.size,
      savedPercent,
      downloadUrl: `/api/download/${path.basename(outputPath)}`,
      filename: `comprimido-${req.file.originalname}`
    });

  } catch (err) {
    await cleanupFiles(inputPath, outputPath);
    if (jobId) sendProgress(jobId, -1, 'Error');
    console.error('compress-pdf:', err.message);
    res.status(500).json({ error: 'Error al comprimir el PDF' });
  }
});

// ─── UNIR PDFs ────────────────────────────────────────────────────────────────
app.post('/api/pdf/merge', upload.array('files', 30), checkSize(LIMITS.pdf), async (req, res) => {
  if (!req.files || req.files.length < 2) {
    return res.status(400).json({ error: 'Necesitás al menos 2 archivos PDF' });
  }

  const outputPath = path.join(TMP_DIR, `merged-${uuidv4()}.pdf`);
  const jobId = req.body.jobId;

  try {
    const mergedPdf = await PDFDocument.create();
    const total = req.files.length;

    for (let i = 0; i < total; i++) {
      if (jobId) sendProgress(jobId, Math.round((i / total) * 90), `Uniendo archivo ${i + 1} de ${total}...`);
      const pdfBytes = await fsp.readFile(req.files[i].path);
      const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => mergedPdf.addPage(page));
    }

    const mergedBytes = await mergedPdf.save();
    await fsp.writeFile(outputPath, mergedBytes);

    req.files.forEach(f => scheduleCleanup(f.path));
    scheduleCleanup(outputPath);

    if (jobId) sendProgress(jobId, 100, 'Listo');

    res.json({
      success: true,
      pages: mergedPdf.getPageCount(),
      downloadUrl: `/api/download/${path.basename(outputPath)}`,
      filename: 'unido.pdf'
    });

  } catch (err) {
    req.files.forEach(f => cleanupFiles(f.path));
    await cleanupFiles(outputPath);
    if (jobId) sendProgress(jobId, -1, 'Error');
    console.error('merge-pdf:', err.message);
    res.status(500).json({ error: 'Error al unir los PDFs' });
  }
});

// ─── DIVIDIR PDF ──────────────────────────────────────────────────────────────
app.post('/api/pdf/split', upload.single('file'), checkSize(LIMITS.pdf), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  const inputPath = req.file.path;
  const mode = req.body.mode || 'all';
  const rangeFrom = parseInt(req.body.from) || 1;
  const rangeTo = parseInt(req.body.to) || 9999;
  const specificPages = (req.body.pages || '').split(',').map(p => parseInt(p.trim())).filter(Boolean);
  const jobId = req.body.jobId;

  try {
    if (jobId) sendProgress(jobId, 10, 'Leyendo PDF...');
    const pdfBytes = await fsp.readFile(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = pdfDoc.getPageCount();

    let pagesToExtract = [];
    if (mode === 'all') {
      pagesToExtract = Array.from({ length: totalPages }, (_, i) => i);
    } else if (mode === 'range') {
      const from = Math.max(1, rangeFrom) - 1;
      const to = Math.min(totalPages, rangeTo) - 1;
      pagesToExtract = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    } else if (mode === 'specific') {
      pagesToExtract = specificPages.map(p => p - 1).filter(p => p >= 0 && p < totalPages);
    }

    if (!pagesToExtract.length) {
      return res.status(400).json({ error: 'No hay páginas válidas para extraer' });
    }

    // Muchas páginas → ZIP
    if (pagesToExtract.length > 1) {
      const zipPath = path.join(TMP_DIR, `split-${uuidv4()}.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.pipe(output);

      for (let i = 0; i < pagesToExtract.length; i++) {
        if (jobId) sendProgress(jobId, 10 + Math.round((i / pagesToExtract.length) * 85), `Extrayendo página ${i + 1}...`);
        const newPdf = await PDFDocument.create();
        const [page] = await newPdf.copyPages(pdfDoc, [pagesToExtract[i]]);
        newPdf.addPage(page);
        const pageBytes = await newPdf.save();
        archive.append(Buffer.from(pageBytes), { name: `pagina-${pagesToExtract[i] + 1}.pdf` });
      }

      await new Promise((resolve, reject) => {
        output.on('close', resolve);
        archive.on('error', reject);
        archive.finalize();
      });

      scheduleCleanup(inputPath);
      scheduleCleanup(zipPath);

      if (jobId) sendProgress(jobId, 100, 'Listo');

      return res.json({
        success: true,
        pages: pagesToExtract.length,
        downloadUrl: `/api/download/${path.basename(zipPath)}`,
        filename: 'paginas.zip'
      });
    }

    // Una sola página
    const newPdf = await PDFDocument.create();
    const pages = await newPdf.copyPages(pdfDoc, pagesToExtract);
    pages.forEach(p => newPdf.addPage(p));
    const outBytes = await newPdf.save();
    const outPath = path.join(TMP_DIR, `split-${uuidv4()}.pdf`);
    await fsp.writeFile(outPath, outBytes);

    scheduleCleanup(inputPath);
    scheduleCleanup(outPath);

    if (jobId) sendProgress(jobId, 100, 'Listo');

    res.json({
      success: true,
      pages: 1,
      downloadUrl: `/api/download/${path.basename(outPath)}`,
      filename: `pagina-${pagesToExtract[0] + 1}.pdf`
    });

  } catch (err) {
    await cleanupFiles(inputPath);
    if (jobId) sendProgress(jobId, -1, 'Error');
    console.error('split-pdf:', err.message);
    res.status(500).json({ error: 'Error al dividir el PDF' });
  }
});

// ─── WORD / EXCEL / PPT → PDF ─────────────────────────────────────────────────
app.post('/api/convert/to-pdf', upload.single('file'), checkSize(LIMITS.doc), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  const inputPath = req.file.path;
  const jobId = req.body.jobId;

  try {
    if (jobId) sendProgress(jobId, 10, 'Convirtiendo con LibreOffice...');

    await execFileAsync('soffice', [
      '--headless',
      '--convert-to', 'pdf',
      '--outdir', TMP_DIR,
      inputPath
    ], { timeout: 3 * 60 * 1000 });

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(TMP_DIR, `${baseName}.pdf`);

    if (!fs.existsSync(outputPath)) throw new Error('LibreOffice no generó el PDF');

    scheduleCleanup(inputPath);
    scheduleCleanup(outputPath);

    if (jobId) sendProgress(jobId, 100, 'Listo');

    const originalName = path.basename(req.file.originalname, path.extname(req.file.originalname));
    res.json({
      success: true,
      downloadUrl: `/api/download/${path.basename(outputPath)}`,
      filename: `${originalName}.pdf`
    });

  } catch (err) {
    await cleanupFiles(inputPath);
    if (jobId) sendProgress(jobId, -1, 'Error');
    console.error('to-pdf:', err.message);
    res.status(500).json({ error: 'Error al convertir. Asegurate de que LibreOffice esté instalado.' });
  }
});

// ─── PDF → WORD ───────────────────────────────────────────────────────────────
app.post('/api/convert/pdf-to-word', upload.single('file'), checkSize(LIMITS.pdf), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  const inputPath = req.file.path;
  const jobId = req.body.jobId;

  try {
    if (jobId) sendProgress(jobId, 10, 'Convirtiendo PDF a Word...');

    await execFileAsync('soffice', [
      '--headless',
      '--infilter=writer_pdf_import',
      '--convert-to', 'docx',
      '--outdir', TMP_DIR,
      inputPath
    ], { timeout: 3 * 60 * 1000 });

    const baseName = path.basename(inputPath, '.pdf');
    const outputPath = path.join(TMP_DIR, `${baseName}.docx`);

    if (!fs.existsSync(outputPath)) throw new Error('Conversión fallida');

    scheduleCleanup(inputPath);
    scheduleCleanup(outputPath);

    if (jobId) sendProgress(jobId, 100, 'Listo');

    const originalName = path.basename(req.file.originalname, '.pdf');
    res.json({
      success: true,
      downloadUrl: `/api/download/${path.basename(outputPath)}`,
      filename: `${originalName}.docx`
    });

  } catch (err) {
    await cleanupFiles(inputPath);
    if (jobId) sendProgress(jobId, -1, 'Error');
    console.error('pdf-to-word:', err.message);
    res.status(500).json({ error: 'Error al convertir PDF a Word' });
  }
});

// ─── COMPRIMIR IMAGEN ─────────────────────────────────────────────────────────
app.post('/api/image/compress', upload.single('file'), checkSize(LIMITS.image), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  const inputPath = req.file.path;
  const quality = parseInt(req.body.quality) || 80;
  const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
  const outputPath = path.join(TMP_DIR, `compressed-${uuidv4()}.${ext === 'jpg' ? 'jpg' : ext}`);
  const jobId = req.body.jobId;

  try {
    if (jobId) sendProgress(jobId, 20, 'Comprimiendo imagen...');

    let sharpInstance = sharp(inputPath);

    if (ext === 'jpg' || ext === 'jpeg') {
      sharpInstance = sharpInstance.jpeg({ quality, mozjpeg: true });
    } else if (ext === 'png') {
      sharpInstance = sharpInstance.png({ quality, compressionLevel: 9 });
    } else if (ext === 'webp') {
      sharpInstance = sharpInstance.webp({ quality });
    } else if (ext === 'avif') {
      sharpInstance = sharpInstance.avif({ quality });
    } else {
      sharpInstance = sharpInstance.jpeg({ quality });
    }

    await sharpInstance.toFile(outputPath);

    const [inputStat, outputStat] = await Promise.all([
      fsp.stat(inputPath),
      fsp.stat(outputPath)
    ]);

    const savedPercent = Math.max(0, Math.round(((inputStat.size - outputStat.size) / inputStat.size) * 100));

    scheduleCleanup(inputPath);
    scheduleCleanup(outputPath);

    if (jobId) sendProgress(jobId, 100, 'Listo');

    res.json({
      success: true,
      originalSize: inputStat.size,
      compressedSize: outputStat.size,
      savedPercent,
      downloadUrl: `/api/download/${path.basename(outputPath)}`,
      filename: `comprimida-${req.file.originalname}`
    });

  } catch (err) {
    await cleanupFiles(inputPath, outputPath);
    if (jobId) sendProgress(jobId, -1, 'Error');
    console.error('compress-image:', err.message);
    res.status(500).json({ error: 'Error al comprimir la imagen' });
  }
});

// ─── CONVERTIR IMAGEN ─────────────────────────────────────────────────────────
app.post('/api/image/convert', upload.single('file'), checkSize(LIMITS.image), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });

  const inputPath = req.file.path;
  const targetFormat = (req.body.format || 'webp').toLowerCase();
  const quality = parseInt(req.body.quality) || 90;
  const jobId = req.body.jobId;

  const formatMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp', avif: 'avif', gif: 'gif', tiff: 'tiff' };
  const sharpFormat = formatMap[targetFormat];

  if (!sharpFormat) {
    await cleanupFiles(inputPath);
    return res.status(400).json({ error: 'Formato destino no soportado' });
  }

  const outputExt = targetFormat === 'jpeg' ? 'jpg' : targetFormat;
  const outputPath = path.join(TMP_DIR, `converted-${uuidv4()}.${outputExt}`);

  try {
    if (jobId) sendProgress(jobId, 20, `Convirtiendo a ${targetFormat.toUpperCase()}...`);

    const inst = sharp(inputPath);
    if (sharpFormat === 'jpeg') inst.jpeg({ quality });
    else if (sharpFormat === 'png') inst.png({ quality });
    else if (sharpFormat === 'webp') inst.webp({ quality });
    else if (sharpFormat === 'avif') inst.avif({ quality });
    else if (sharpFormat === 'gif') inst.gif();
    else if (sharpFormat === 'tiff') inst.tiff({ quality });

    await inst.toFile(outputPath);

    scheduleCleanup(inputPath);
    scheduleCleanup(outputPath);

    if (jobId) sendProgress(jobId, 100, 'Listo');

    const originalName = path.basename(req.file.originalname, path.extname(req.file.originalname));
    res.json({
      success: true,
      downloadUrl: `/api/download/${path.basename(outputPath)}`,
      filename: `${originalName}.${outputExt}`
    });

  } catch (err) {
    await cleanupFiles(inputPath, outputPath);
    if (jobId) sendProgress(jobId, -1, 'Error');
    console.error('convert-image:', err.message);
    res.status(500).json({ error: 'Error al convertir la imagen' });
  }
});

// ─── DESCARGA ─────────────────────────────────────────────────────────────────
app.get('/api/download/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filepath = path.join(TMP_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: 'Archivo no encontrado o expirado (máx. 10 minutos)' });
  }

  const mimeTypes = {
    '.pdf':  'application/pdf',
    '.zip':  'application/zip',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.webp': 'image/webp',
    '.gif':  'image/gif',
    '.avif': 'image/avif',
    '.tiff': 'image/tiff',
  };

  const ext = path.extname(filename).toLowerCase();
  const downloadName = req.query.name || filename;
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.sendFile(filepath);
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.1.0', limits: { pdf: '500MB', image: '100MB', doc: '200MB' } });
});

// ─── Frontend estático ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Limpieza periódica de tmp (cada hora) ────────────────────────────────────
setInterval(async () => {
  try {
    const files = await fsp.readdir(TMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const fp = path.join(TMP_DIR, file);
      const stat = await fsp.stat(fp).catch(() => null);
      if (stat && now - stat.mtimeMs > 60 * 60 * 1000) {
        await fsp.unlink(fp).catch(() => {});
      }
    }
  } catch (_) {}
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`TodoArchivos server corriendo en puerto ${PORT}`);
});

module.exports = app;
