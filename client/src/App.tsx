import { useState } from 'react'
import axios from 'axios'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL

interface ShortenResponse {
  shortCode: string
  shortUrl: string
  originalUrl: string
  expiresAt: string | null
  createdAt: string
}

interface StatsResponse {
  shortCode: string
  originalUrl: string
  clickCount: number
  createdAt: string
  expiresAt: string | null
  isActive: boolean
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button className="copy-btn" onClick={handleCopy}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

export default function App() {
  const [url, setUrl] = useState('')
  const [result, setResult] = useState<ShortenResponse | null>(null)
  const [shortenLoading, setShortenLoading] = useState(false)
  const [shortenError, setShortenError] = useState('')
  const [statsCode, setStatsCode] = useState('')
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsError, setStatsError] = useState('')

  const handleShorten = async () => {
    if (!url.trim()) { setShortenError('Please enter a URL'); return }
    setShortenLoading(true); setShortenError(''); setResult(null)
    try {
      const response = await axios.post(`${API_URL}/api/urls`, { url })
      setResult(response.data.data)
    } catch (err: any) {
      const message = err.response?.data?.error?.message || err.response?.data?.error?.details?.[0]?.message || 'Something went wrong'
      setShortenError(message)
    } finally { setShortenLoading(false) }
  }

  const handleStats = async () => {
    if (!statsCode.trim()) { setStatsError('Please enter a short code'); return }
    setStatsLoading(true); setStatsError(''); setStats(null)
    try {
      const response = await axios.get(`${API_URL}/api/urls/${statsCode.trim()}/stats`)
      setStats(response.data.data)
    } catch (err: any) {
      const message = err.response?.data?.error?.message || 'Short URL not found'
      setStatsError(message)
    } finally { setStatsLoading(false) }
  }

  const handleShortenKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleShorten() }
  const handleStatsKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleStats() }

  const truncate = (str: string, n: number) => str.length > n ? str.substring(0, n) + '...' : str

  return (
    <div className="page">
      <header className="header">
        <div className="logo">snip</div>
        <p className="tagline">Short links, instantly</p>
      </header>

      <main className="main">

        <section className="card">
          <h2 className="card-title">Shorten a URL</h2>
          <div className="input-row">
            <input
              className="input"
              type="url"
              placeholder="https://your-long-url.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={handleShortenKey}
              disabled={shortenLoading}
            />
            <button className="btn-primary" onClick={handleShorten} disabled={shortenLoading}>
              {shortenLoading ? 'Shortening...' : 'Shorten'}
            </button>
          </div>
          {shortenError && <p className="error">{shortenError}</p>}
          {result && (
            <div className="result">
              <div className="result-row">
                <a className="short-link" href={result.shortUrl} target="_blank" rel="noreferrer">
                  {result.shortUrl}
                </a>
                <CopyButton text={result.shortUrl} />
              </div>
              <p className="result-original">{result.originalUrl}</p>
            </div>
          )}
        </section>

        <section className="card">
          <h2 className="card-title">Check Stats</h2>
          <div className="input-row">
            <input
              className="input"
              type="text"
              placeholder="Enter short code e.g. 000001"
              value={statsCode}
              onChange={(e) => setStatsCode(e.target.value)}
              onKeyDown={handleStatsKey}
              disabled={statsLoading}
            />
            <button className="btn-secondary" onClick={handleStats} disabled={statsLoading}>
              {statsLoading ? 'Loading...' : 'Get Stats'}
            </button>
          </div>
          {statsError && <p className="error">{statsError}</p>}
          {stats && (
            <div className="stats">
              <div className="stat-row">
                <span className="stat-label">Short code</span>
                <span className="stat-value">{stats.shortCode}</span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Clicks</span>
                <span className="stat-value stat-clicks">{stats.clickCount}</span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Status</span>
                <span className={stats.isActive ? 'stat-value stat-active' : 'stat-value stat-inactive'}>
                  {stats.isActive ? 'Active' : 'Deactivated'}
                </span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Created</span>
                <span className="stat-value">{new Date(stats.createdAt).toLocaleDateString()}</span>
              </div>
              {stats.expiresAt && (
                <div className="stat-row">
                  <span className="stat-label">Expires</span>
                  <span className="stat-value">{new Date(stats.expiresAt).toLocaleDateString()}</span>
                </div>
              )}
              <div className="stat-row original-row">
                <span className="stat-label">Original</span>
                <a href={stats.originalUrl} target="_blank" rel="noreferrer" className="stat-link">
                  {truncate(stats.originalUrl, 50)}
                </a>
              </div>
            </div>
          )}
        </section>

      </main>

      <footer className="footer">
        Built with Node.js and PostgreSQL and Redis
      </footer>
    </div>
  )
}
