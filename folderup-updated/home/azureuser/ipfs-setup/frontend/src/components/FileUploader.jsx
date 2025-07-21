import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;

const FileUploader = () => {
  const [filesToUpload, setFilesToUpload] = useState([]);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadSpeed, setUploadSpeed] = useState(null);
  const [timeLeft, setTimeLeft] = useState(null);
  const [files, setFiles] = useState([]);
  const uploadStartTimeRef = useRef(null);
  const cancelTokenRef = useRef(null);

  const handleFolderChange = (e) => {
    const selectedFiles = Array.from(e.target.files);
    if (!selectedFiles.length) return;
    setFilesToUpload(selectedFiles);
  };

  const handleUpload = async () => {
    if (!filesToUpload.length) return;

    const formData = new FormData();
    filesToUpload.forEach(file => {
      formData.append('file', file, file.webkitRelativePath);
    });

    setUploading(true);
    setProgress(0);
    uploadStartTimeRef.current = Date.now();

    const cancelSource = axios.CancelToken.source();
    cancelTokenRef.current = cancelSource;

    try {
      const res = await axios.post(`${BACKEND_URL}/upload-folder`, formData, {
        cancelToken: cancelSource.token,
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (event) => {
          if (event.total) {
            const pct = Math.round((event.loaded * 100) / event.total);
            setProgress(pct);

            const elapsed = (Date.now() - uploadStartTimeRef.current) / 1000;
            if (elapsed > 0) {
              const avgSpeed = event.loaded / elapsed;
              setUploadSpeed(avgSpeed);
              const bytesLeft = event.total - event.loaded;
              setTimeLeft(bytesLeft / avgSpeed);
            }
          }
        }
      });

      const uploadedCid = res.data?.cid;
      const folderName = res.data?.folderName || "Folder";

      if (uploadedCid) {
        toast.success(`✅ Uploaded! CID: ${uploadedCid}`);
        setFiles([{ filename: folderName, cid: uploadedCid }, ...files]);
      } else {
        toast.warn("⚠️ Upload succeeded but CID not returned.");
      }

      setFilesToUpload([]);
      fetchFiles(); // refresh file list from backend

    } catch (err) {
      if (axios.isCancel(err)) {
        toast.info('Upload canceled');
      } else {
        toast.error('❌ Upload failed');
      }
    } finally {
      setUploading(false);
      setUploadSpeed(null);
      setTimeLeft(null);
    }
  };

  const handleCancel = () => {
    cancelTokenRef.current?.cancel();
  };

  const fetchFiles = async () => {
    try {
      const res = await axios.get(`${BACKEND_URL}/files`);
      setFiles(res.data);
    } catch {
      toast.error('❌ Failed to fetch files');
    }
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  const formatSpeed = (bps) =>
    bps >= 1024 * 1024
      ? `${(bps / (1024 * 1024)).toFixed(2)} MB/s`
      : `${(bps / 1024).toFixed(2)} KB/s`;

  const formatTimeLeft = (secs) =>
    !secs || !isFinite(secs)
      ? '-'
      : secs < 60
      ? `${Math.round(secs)}s left`
      : `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s left`;

  return (
    <div style={{ padding: '2rem', fontFamily: 'Arial, sans-serif' }}>
      <ToastContainer position="top-right" autoClose={3000} />
      <h2>📁 Upload Folder to IPFS</h2>

      <input
        type="file"
        webkitdirectory="true"
        multiple
        onChange={handleFolderChange}
        style={{ marginBottom: '1rem' }}
      />

      {filesToUpload.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <strong>Selected Folder:</strong>
          <ul>
            {filesToUpload.map((f, i) => (
              <li key={i}>{f.webkitRelativePath}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <button onClick={handleUpload} disabled={uploading || !filesToUpload.length}>
          {uploading ? 'Uploading...' : 'Upload Folder'}
        </button>
        {uploading && (
          <button
            onClick={handleCancel}
            style={{ marginLeft: '1rem', backgroundColor: '#dc2626', color: 'white' }}
          >
            Cancel
          </button>
        )}
      </div>

      {uploading && (
        <div style={{ marginTop: '1rem', maxWidth: '400px' }}>
          <div style={{ width: '100%', background: '#e5e7eb', borderRadius: '4px', height: '14px' }}>
            <div
              style={{
                width: `${progress}%`,
                background: '#4f46e5',
                height: '100%',
                transition: 'width 0.3s',
              }}
            />
          </div>
          <p style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px' }}>
            <span>{progress}%</span>
            <span>{formatSpeed(uploadSpeed)}</span>
            <span>{formatTimeLeft(timeLeft)}</span>
          </p>
        </div>
      )}

      <h3 style={{ marginTop: '2rem' }}>📦 Uploaded Files</h3>
      <ul>
        {files.length === 0 ? (
          <li>No files uploaded yet.</li>
        ) : (
          files.map((f, idx) => (
            <li key={idx}>
              <strong>{f.filename}</strong> — CID: <code>{f.cid}</code>
              &nbsp;&nbsp;
              <a
                href={`${BACKEND_URL}/download/${f.cid}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'blue' }}
              >
                ⬇️ Download
              </a>
            </li>
          ))
        )}
      </ul>
    </div>
  );
};

export default FileUploader;
