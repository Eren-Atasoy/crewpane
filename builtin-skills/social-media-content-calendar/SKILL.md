---
name: social-media-content-calendar
description: Plan a multi-platform social campaign — brief, content pillars, per-platform posts, a dated calendar. Use for a launch or a recurring content push ("icerik takvimi", "sosyal medya plani", "lansman postlari"). Do NOT use for a single one-off post.
license: MIT
metadata:
  crewpane.origin: builtin
  crewpane.author: Ben Barclay (benbarclay), Hermes Agent
  crewpane.copyright: Copyright (c) 2025 Nous Research
  crewpane.sourceCatalog: social-media-content-calendar@0.1.0
  crewpane.upstreamCommit: e818025
  crewpane.upstreamSha256: f12b235ea3eedf611022c0a89a967f08a5dc25bbd1531572f1c37f7545177298
  crewpane.modified: yes
  crewpane.status: published
  crewpane.reviewedBy: ironhide
  crewpane.reviewedAt: 2026-08-18
  upstream.version: 0.1.0
  upstream.author: Ben Barclay (benbarclay), Hermes Agent
  upstream.platforms: [linux, macos, windows]
  upstream.tags: [Social-Media, Content-Calendar, Campaigns, Publishing]
---

# Social Media Content Calendar

Plan a concrete calendar across selected social platforms. This skill owns campaign structure, post briefs, channel adaptation, approvals, and publishing verification; platform skills such as `xurl` own API commands. For platforms without a connector, the verified handoff ends at approved drafts for the user's scheduler — say so rather than claiming publication.

## When to Use

- "Build next month's social calendar."
- "Turn this launch into posts for X, LinkedIn, Instagram, and TikTok."
- "Draft and schedule a campaign."
- "Repurpose these articles/videos into social content."

Don't use for: single one-off posts (use the platform skill directly).

## Procedure

### 1. Define campaign constraints

Record objective, audience, offer/message, platforms, date range, cadence, voice, mandatory/prohibited claims, links, tracking convention, localization, and approval/publishing authority. Done when each proposed post has a clear business purpose.

### 2. Inventory source material

Collect verified product facts, launches, articles, media, testimonials with permission, brand assets, and key dates using Read and WebFetch. Mark claim owners and expiration. Done when unsupported claims and missing assets are visible.

### 3. Build themes and calendar slots

Create a balanced mix such as education, proof, product, community, event, behind-the-scenes, and conversation. Account for platform cadence and campaign milestones. Done when dates, platforms, themes, and objectives form a coherent calendar rather than duplicate cross-posts.

### 4. Write platform-specific briefs

For each post specify hook, core message, format, copy length, CTA, link, asset dimensions/content, accessibility text, tags/mentions, and success metric. Adapt rather than copy-paste between platforms. Done when a creator can produce the asset without hidden context.

### 5. Draft copy and assets

Load `humanizer` for voice; generate visuals with the `image_generate` tool where assets are needed. Preserve factual claims and shared campaign identity while respecting platform norms. Done when every calendar slot has draft copy and asset status.

### 6. Run editorial and risk review

Check factual accuracy, tone, repetition, rights/permissions, accessibility, disclosures, link destination, date relevance, and crisis sensitivity. Mark `draft`, `needs review`, or `approved`; do not publish from draft. Done when every post has a disposition and owner.

### 7. Schedule or hand off

Present the approval batch. Publish/schedule only approved posts using available platform skills (`xurl` for X); for platforms without a connector, deliver the approved package (copy, assets, timing) for the user's scheduling tool and mark those slots handed-off, not published. Read back scheduled time, account, content preview, and provider post/job ID for anything actually published. Done when the calendar reflects verified publishing or handoff status per slot.

## Pitfalls

- Identical copy on every platform.
- Filling cadence with low-value repetitive posts.
- Publishing unverified metrics, testimonials, or future claims.
- Confusing generated asset completion with scheduled publication.
- Claiming "scheduled" for platforms where the handoff ended at drafts.

## Verification

- [ ] Every post traces to a campaign objective and a verified claim inventory.
- [ ] No post was published from `draft` or `needs review` state.
- [ ] Published slots have provider-confirmed IDs; handed-off slots are marked as such.
- [ ] Rights, permissions, and disclosures checked before any publish.
