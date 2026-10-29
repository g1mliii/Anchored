<p align="center">
  <a href="https://anchored.site"><img src="anchore%20wout%20background%20512x512.png" width="112" height="112" alt="Anchored" /></a>
</p>

<h1 align="center">Anchored</h1>

<p align="center">
  <b>Notes and highlights that stay anchored to the page you took them on.</b><br />
  Encrypted on your device, organized by site, and synced wherever you work.
</p>

> [!IMPORTANT]
> **Anchored has been discontinued and is no longer maintained.**
> The extension has been removed from the Chrome, Edge and Firefox stores, new accounts are closed,
> and cloud sync will be switched off. This repository is kept read-only for reference.
>
> **Existing users:** export your notes from the extension (Settings → Export) or from the
> [web dashboard](https://anchored.site/dashboard) while it is still online.
> Questions: support@anchored.site

---

**Anchored** is a note-taking solution that lets you anchor your ideas to specific web locations. Available as both a browser extension and web application, it provides secure, encrypted note storage with intelligent organization and AI-powered features.

## What is Anchored?

Anchored represents the concept of anchoring your thoughts and insights to specific web locations. Whether you're researching, learning, or working, Anchored helps you capture and organize notes contextually with the websites you visit.

### Key Features

- **Smart Organization**: Notes automatically organized by domain and URL
- **Zero-Knowledge Encryption**: Your notes are encrypted client-side before cloud storage
- **Ocean-Themed Design**: Glassmorphism UI with nautical-inspired aesthetics
- **Cross-Platform**: Browser extension + responsive web application
- **AI-Powered**: Intelligent summarization and content extraction (500 tokens/month for premium)
- **Affordable Premium**: Full-featured premium tier for $2.50/month

## Getting Started

### Browser Extension
1. Load the `/extension/` folder as an unpacked extension (the store listings are no longer available)
2. Click the Anchored icon in your browser toolbar
3. Start taking notes on any website
4. Notes are automatically organized by domain/URL
5. Keyboard shortcuts: Alt+E (open popup), Alt+N (new note)

### Web Application
1. Visit [anchored.site](https://anchored.site)
2. Create your account or sign in
3. Access your synced notes from any device
4. Manage your subscription and export your data

## Pricing

### Free Tier
- Browser extension with local storage
- Unlimited notes on your device
- Domain/URL organization
- Multi-highlight mode and context menu
- Rich text formatting and tags
- Keyboard shortcuts and themes
- Basic export functionality
- AI features (30 tokens/month)

### Premium - $2.50/month
- Everything in Free tier
- Cloud synchronization across all devices
- Web application access
- AI features (500 tokens/month)
- Advanced search across all notes
- Full export/import (JSON, Markdown, Obsidian, Notion, Plain Text, Google Docs)
- Version history and note recovery
- Ad-free experience

## Architecture

### Browser Extension
- Manifest V3 compliant
- Local-first architecture with IndexedDB
- Zero-knowledge encryption using AES-256-GCM
- Offline-capable with background sync

### Web Application
- Static hosting on GitHub Pages
- Supabase backend for authentication and data sync
- Client-side encryption maintains zero-knowledge architecture
- Progressive Web App capabilities

### Security & Privacy
- **Client-side encryption**: Notes encrypted before leaving your device
- **Password-derived keys**: Encryption keys derived from your password + salt
- **Zero-knowledge**: Server never sees your unencrypted notes
- **Row-level security**: Database policies enforce strict data isolation

## Technology Stack

### Frontend
- Vanilla JavaScript (no build system required)
- CSS3 with glassmorphism effects
- Mobile-first responsive design
- Progressive Web App support

### Backend
- Supabase (PostgreSQL with real-time capabilities)
- Edge Functions (TypeScript serverless)
- Stripe for payment processing
- GitHub Pages for static hosting

### Browser Extension
- Manifest V3 architecture
- IndexedDB for local storage
- Service Workers for background sync
- Chrome APIs (tabs, storage, alarms, context menus)

## Browser Support

- **Chrome** 90+, **Microsoft Edge**, **Brave** and other Chromium browsers - load `/extension/` (or `/extension-edge/`) unpacked
- **Firefox** 109+ - load `/extension-firefox/` as a temporary add-on

## Development

This project uses a local-first architecture with cloud sync:

- **Extension**: No build system required - load `/extension/` folder directly in Chrome
- **Web App**: Static files deployed to GitHub Pages
- **Database**: Supabase PostgreSQL with Row Level Security
- **Sync**: Client-side encryption with zero-knowledge architecture

### Quick Start
1. Clone the repository
2. Load `/extension/` folder as unpacked extension in Chrome
3. Visit [anchored.site](https://anchored.site) for web app
4. Create account to test sync functionality

## License

This project is proprietary software. All rights reserved.

## Support

- **Email**: support@anchored.site
- **Website**: [anchored.site](https://anchored.site)
- **Help**: [anchored.site/help](https://anchored.site/help)
