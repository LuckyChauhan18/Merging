require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const PORT = process.env.PORT || 3000;

// --- R2 Client ---
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL_PREFIX;

// --- R2 Helpers ---
async function uploadToR2(key, filePath, contentType) {
  const body = fs.readFileSync(filePath);
  await r2.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
  return `${R2_PUBLIC_URL}/${key}`;
}

async function getR2DownloadUrl(key) {
  return getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: 3600 }
  );
}


// --- Temp dir for uploads (works on Render's ephemeral /tmp) ---
const tmpBase = path.join(os.tmpdir(), "video-merger");
fs.mkdirSync(tmpBase, { recursive: true });

const storage = multer.diskStorage({
  destination: tmpBase,
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const videoExts = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
    const audioExts = [".mp3", ".wav", ".aac", ".ogg", ".m4a", ".flac"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, videoExts.includes(ext) || audioExts.includes(ext));
  },
  limits: { fileSize: 500 * 1024 * 1024 },
});

// --- Static files ---
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));

// --- Upload & Merge ---
const mergeUpload = upload.fields([
  { name: "videos", maxCount: 5 },
  { name: "audio", maxCount: 1 },
]);

app.post("/api/merge", mergeUpload, async (req, res) => {
  const mode = req.body.mode || "merge"; // "merge" or "sync"
  const videoFiles = req.files["videos"] || [];
  const audioFiles = req.files["audio"] || [];
  const audioFile = audioFiles[0] || null;
  const allFiles = [...videoFiles, ...audioFiles];

  // Validation
  if (mode === "merge" && videoFiles.length < 2) {
    allFiles.forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ error: "Please upload at least 2 videos" });
  }
  if (mode === "sync" && videoFiles.length < 1) {
    allFiles.forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ error: "Please upload at least 1 video" });
  }
  if (mode === "sync" && !audioFile) {
    allFiles.forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ error: "Please upload an audio file" });
  }
  if (videoFiles.length > 5) {
    allFiles.forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });
    return res.status(400).json({ error: "Maximum 5 videos allowed" });
  }

  const jobId = crypto.randomBytes(8).toString("hex");
  const jobDir = path.join(tmpBase, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    // 1. Upload inputs to R2
    const r2InputKeys = [];
    for (let i = 0; i < videoFiles.length; i++) {
      const f = videoFiles[i];
      const r2Key = `jobs/${jobId}/input/${i + 1}-${f.originalname}`;
      await uploadToR2(r2Key, f.path, f.mimetype || "video/mp4");
      r2InputKeys.push(r2Key);
    }
    if (audioFile) {
      const audioR2Key = `jobs/${jobId}/input/audio-${audioFile.originalname}`;
      await uploadToR2(audioR2Key, audioFile.path, audioFile.mimetype || "audio/mpeg");
    }

    const outputFileName = `merged_${jobId}.mp4`;
    const outputPath = path.join(jobDir, outputFileName);

    if (mode === "sync") {
      // --- SYNC MODE: merge videos + overlay audio with perfect lip sync ---
      let videoInput = videoFiles[0].path;

      // If multiple videos, concat them first with re-encoding for uniform timestamps
      if (videoFiles.length > 1) {
        const concatFile = path.join(jobDir, "concat.txt");
        const concatContent = videoFiles
          .map((f) => `file '${f.path.replace(/\\/g, "/")}'`)
          .join("\n");
        fs.writeFileSync(concatFile, concatContent);

        videoInput = path.join(jobDir, `concat_${jobId}.mp4`);
        // Re-encode to normalize timestamps across clips for sync accuracy
        execSync(
          `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:v libx264 -preset fast -crf 23 -an -vsync cfr "${videoInput}"`,
          { stdio: "pipe", timeout: 600000 }
        );
      }

      // Combine video + audio with perfect sync:
      // -vsync cfr: constant frame rate for consistent timing
      // -async 1: correct audio start to align with video PTS from frame 0
      // -af aresample=async=1: resample audio to stay in sync throughout
      execSync(
        `ffmpeg -y -i "${videoInput}" -i "${audioFile.path}" ` +
        `-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k ` +
        `-map 0:v:0 -map 1:a:0 ` +
        `-vsync cfr -async 1 -af "aresample=async=1" ` +
        `-shortest "${outputPath}"`,
        { stdio: "pipe", timeout: 600000 }
      );
    } else {
      // --- MERGE MODE: concat videos with their existing audio ---
      const concatFile = path.join(jobDir, "concat.txt");
      const concatContent = videoFiles
        .map((f) => `file '${f.path.replace(/\\/g, "/")}'`)
        .join("\n");
      fs.writeFileSync(concatFile, concatContent);

      execSync(
        `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}"`,
        { stdio: "pipe", timeout: 300000 }
      );
    }

    // Upload to R2
    const r2OutputKey = `jobs/${jobId}/output/${outputFileName}`;
    const publicUrl = await uploadToR2(r2OutputKey, outputPath, "video/mp4");

    // Cleanup
    allFiles.forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });
    fs.rmSync(jobDir, { recursive: true, force: true });

    res.json({
      success: true,
      jobId,
      url: publicUrl,
      downloadUrl: `/api/download/${jobId}/${outputFileName}`,
      inputFiles: r2InputKeys.map((key, i) => ({
        name: videoFiles[i].originalname,
        url: `${R2_PUBLIC_URL}/${key}`,
      })),
    });
  } catch (err) {
    allFiles.forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });
    fs.rmSync(jobDir, { recursive: true, force: true });
    res.status(500).json({ error: "Failed to process: " + err.message });
  }
});

// --- Download (presigned URL from R2) ---
app.get("/api/download/:jobId/:filename", async (req, res) => {
  try {
    const { jobId, filename } = req.params;
    const safeJob = path.basename(jobId);
    const safeFile = path.basename(filename);
    const r2Key = `jobs/${safeJob}/output/${safeFile}`;

    const signedUrl = await getR2DownloadUrl(r2Key);
    res.redirect(signedUrl);
  } catch (err) {
    res.status(404).json({ error: "File not found" });
  }
});

// --- Health check (for Render) ---
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
