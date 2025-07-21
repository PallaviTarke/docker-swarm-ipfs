import express from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import fs from 'fs';
import fsPromises from 'fs/promises';
import cors from 'cors';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { AbortController } from 'abort-controller';
import fse from 'fs-extra';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10gb' }));
app.use(express.urlencoded({ extended: true, limit: '10gb' }));

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } ,// 10 GB
preservePath: true,
});

const MONGO_URI = 'mongodb://mongo1:27017,mongo2:27017,mongo3:27017/ipfs-data?replicaSet=rs0';
await mongoose.connect(MONGO_URI);
console.log("✅ MongoDB connected");

const redisClient = new Redis({
  sentinels: [
    { host: 'redis-sentinel1', port: 26379 },
    { host: 'redis-sentinel2', port: 26379 },
    { host: 'redis-sentinel3', port: 26379 }
  ],
  name: 'mymaster'
});

redisClient.on('connect', () => console.log("✅ Redis connected"));
redisClient.on('error', err => console.error("❌ Redis error:", err));

const File = mongoose.model('File', {
  filename: String,
  cid: String,
  size: Number,
  uploadedAt: Date,
  ip: String
});

const CLUSTER_API = 'http://cluster0:9094';
const IPFS_GATEWAYS = [
  'http://ipfs1:8080/ipfs',
  'http://ipfs2:8080/ipfs',
  'http://ipfs3:8080/ipfs',
  'http://ipfs4:8080/ipfs'
];

function getRealIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  if (req.headers['x-real-ip']) return req.headers['x-real-ip'];
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

// app.post('/upload', upload.single('file'), async (req, res) => {
//   if (!req.file) return res.status(400).send("No file provided");

//   const { originalname, path: filePath, size } = req.file;
//   const uploaderIp = getRealIp(req);
//   console.log(`📥 File: ${originalname} (${(size / 1024 / 1024).toFixed(2)} MB) from IP: ${uploaderIp}`);

//   try {
//     const form = new FormData();
//     form.append('file', fs.createReadStream(filePath), { filename: originalname });

//     const controller = new AbortController();
//     const timeout = setTimeout(() => controller.abort(), 300000);

//     let response;
//     try {
//       response = await fetch(`${CLUSTER_API}/add?replication-min=2&replication-max=2`, {
//         method: 'POST',
//         body: form,
//         signal: controller.signal
//       });
//     } catch (err) {
//       throw new Error(`IPFS Cluster error: ${err.message}`);
//     } finally {
//       clearTimeout(timeout);
//     }

//     if (!response.ok) throw new Error("Cluster upload failed");

//     const text = await response.text();
//     let lastCid;

//     const lines = text.trim().split('\n');
//     for (const line of lines) {
//       const obj = JSON.parse(line);
//       if (obj && obj.cid) lastCid = obj.cid['/'] || obj.cid;
//     }

//     if (!lastCid) throw new Error("No CID returned");

//     const fileData = {
//       filename: originalname,
//       cid: lastCid,
//       size,
//       uploadedAt: new Date(),
//       ip: uploaderIp
//     };

//     await File.create(fileData);
//     await redisClient.set(lastCid, JSON.stringify(fileData));

//     console.log(`📌 Pinned to Cluster with CID: ${lastCid}`);
//     res.json({ message: 'File uploaded and pinned', cid: lastCid });
//   } catch (err) {
//     console.error("❌ Upload error:", err.message);
//     res.status(500).send("Upload failed: " + err.message);
//   } finally {
//     if (filePath && fs.existsSync(filePath)) {
//       await fsPromises.unlink(filePath).catch(() => {});
//     }
//   }
// });

app.post('/upload-folder', upload.array('file'), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).send("No files received");
  }
console.log(req.files)
  const uploaderIp = getRealIp(req);
  const folderName = req.body.folderName || `upload-${Date.now()}`;
  const folderPath = path.join('uploads', folderName);

  try {
    // Step 1: Move uploaded files to temp folder, maintaining relative structure
    for (const file of req.files) {
      const relativePath = file.originalname;
      if (!relativePath) throw new Error(`Missing relative path for ${file.filename}`);
      const fullDestPath = path.join(folderPath, relativePath);
      await fse.ensureDir(path.dirname(fullDestPath));
      await fse.move(file.path, fullDestPath);
    }

    // Step 2: Create form with relative file paths using `filepath` (required by IPFS Cluster)
    const form = new FormData();

    const addFilesRecursively = (dir, base = folderName) => {
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const relativePath = path.join(base, entry); // include top-level folder
    if (fs.statSync(fullPath).isDirectory()) {
      addFilesRecursively(fullPath, relativePath);
    } else {
      const normalizedPath = relativePath.split(path.sep).join('/');
      form.append('file', fs.createReadStream(fullPath), {
        filepath: normalizedPath, // must include full folder structure
      });
    }
  }
};
    addFilesRecursively(folderPath);
console.log(JSON.stringify(form,null,2)+ "form")
    // Step 3: Upload to IPFS Cluster with wrap-with-directory and replication
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);

    const response = await fetch(
      `${CLUSTER_API}/add?recursive=true&wrap-with-directory=true&replication-min=2&replication-max=2`,
      {
        method: 'POST',
        body: form,
        signal: controller.signal,
        headers: form.getHeaders()
      }
    );

    clearTimeout(timeout);

    if (!response.ok) throw new Error("IPFS Cluster upload failed");

    const text = await response.text();
    const lines = text.trim().split('\n');

    let rootCid = null;
    for (const line of lines) {
      const obj = JSON.parse(line);
      if (obj.name === '' || obj.name === folderName || obj.name === '/') {
        rootCid = obj.cid['/'] || obj.cid;
        break;
      }
    }
console.log(text)
    if (!rootCid) throw new Error("Root CID not found");

    // // Step 4: Save metadata in MongoDB and Redis
    await File.create({
      filename: folderName,
      cid: rootCid,
      size: req.files.reduce((sum, f) => sum + f.size, 0),
      uploadedAt: new Date(),
      ip: uploaderIp
    });

    await redisClient.set(rootCid, JSON.stringify({ folderName, rootCid }));

    console.log(`📁 Folder uploaded to IPFS Cluster with CID: ${rootCid}`);
    res.json({ message: 'Folder uploaded and pinned', cid: rootCid });

  } catch (err) {
    console.error("❌ Folder upload error:", err.message);
    res.status(500).send("Upload failed: " + err.message);
  } finally {
    // Step 5: Cleanup
    await fse.remove(folderPath).catch(err =>
      console.warn(`⚠️ Cleanup failed for ${folderPath}:`, err.message)
    );
  }
});

app.get('/download/:cid', async (req, res) => {
  const cid = req.params.cid;

  const record = await File.findOne({ cid });
  const filename = record?.filename || cid;

  for (const gateway of IPFS_GATEWAYS) {
    try {
      const url = `${gateway}/${cid}/`; // 👈 add slash to handle folder

      const response = await fetch(url);
      const contentType = response.headers.get('content-type');

      if (response.ok && contentType && !contentType.includes('text/html')) {
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.zip"`);
        response.body.pipe(res);
        return;
      } else {
        console.warn(`⚠️ ${url} returned invalid content-type: ${contentType}`);
      }
    } catch (err) {
      console.warn(`⚠️ ${gateway} fetch error: ${err.message}`);
    }
  }

  res.status(500).send('Download failed from all nodes');
});

app.get('/files', async (req, res) => {
  try {
    const files = await File.find().sort({ uploadedAt: -1 }).limit(20);
    const enriched = [];

    for (const file of files) {
      const cid = file.cid;
      try {
        const clusterRes = await fetch(`${CLUSTER_API}/pins/${cid}`);
        if (clusterRes.ok) {
          const clusterInfo = await clusterRes.json();
          file._doc.replication = {
            allocs: clusterInfo.allocations,
            peerMap: clusterInfo.peer_map
          };
        } else {
          file._doc.replication = { error: "Cluster info unavailable" };
        }
      } catch {
        file._doc.replication = { error: "Fetch failed" };
      }
      enriched.push(file);
    }

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed' });
  }
});

app.delete('/files/:cid', async (req, res) => {
  const { cid } = req.params;
  try {
    const deleted = await File.findOneAndDelete({ cid });
    if (!deleted) return res.status(404).json({ error: 'File not found' });

    await redisClient.del(cid);
    try {
      await fetch(`${CLUSTER_API}/pins/${cid}`, { method: 'DELETE' });
    } catch (err) {
      console.warn(`⚠️ Failed to unpin from cluster: ${err.message}`);
    }

    console.log(`🗑 Deleted CID: ${cid}`);
    res.json({ message: 'File deleted' });
  } catch (err) {
    console.error("❌ Delete error:", err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

const server = app.listen(3000, () => {
  console.log('🚀 Uploader API running on port 3000');
});
server.setTimeout(15 * 60 * 1000);

