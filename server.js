const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '200kb' }));

// Load LinkedIn framework prompt
const FRAMEWORK_PROMPT = fs.readFileSync(path.join(__dirname, 'framework.txt'), 'utf-8');

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// Helper: call Anthropic API
// =============================================
async function callAnthropic(systemPrompt, userMessage, maxTokens = 4000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('API key not configured on server');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  return response.json();
}

// =============================================
// Helper: Apify actor runner
// =============================================
async function runApifyActor(actorId, input) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('Apify API token not configured');

  // Start the actor run
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );

  if (!startRes.ok) {
    const err = await startRes.text();
    throw new Error(`Apify start failed: ${err}`);
  }

  const run = await startRes.json();
  const runId = run.data.id;

  // Poll until finished (max 3 minutes)
  const maxWait = 180000;
  const pollInterval = 3000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    elapsed += pollInterval;

    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`
    );
    const statusData = await statusRes.json();
    const status = statusData.data.status;

    if (status === 'SUCCEEDED') {
      // Fetch dataset items
      const datasetId = statusData.data.defaultDatasetId;
      const itemsRes = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}`
      );
      return itemsRes.json();
    }

    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run ${status}`);
    }
  }

  throw new Error('Apify run timed out after 3 minutes');
}

// =============================================
// Helper: Supabase
// =============================================
async function supabaseQuery(method, table, params = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null; // Gracefully skip if not configured

  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'return=representation' : undefined,
  };
  Object.keys(headers).forEach(k => headers[k] === undefined && delete headers[k]);

  let endpoint = `${url}/rest/v1/${table}`;

  if (method === 'GET') {
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    if (query) endpoint += `?${query}`;
  }

  const res = await fetch(endpoint, {
    method,
    headers,
    body: method !== 'GET' ? JSON.stringify(params.body) : undefined,
  });

  if (!res.ok) return null;
  return res.json();
}

async function getCachedNiche(niche) {
  const normalized = niche.toLowerCase().trim();
  const results = await supabaseQuery('GET', 'niche_cache', {
    'niche': `eq.${normalized}`,
    'select': '*',
    'order': 'created_at.desc',
    'limit': '1',
  });
  if (!results || results.length === 0) return null;

  const cached = results[0];
  const ageMs = Date.now() - new Date(cached.created_at).getTime();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  if (ageMs > sevenDays) return null; // Stale

  return cached;
}

async function saveNicheCache(niche, profiles, posts) {
  const normalized = niche.toLowerCase().trim();
  await supabaseQuery('POST', 'niche_cache', {
    body: {
      niche: normalized,
      profiles: JSON.stringify(profiles),
      posts: JSON.stringify(posts),
      created_at: new Date().toISOString(),
    },
  });
}

// =============================================
// API: Generic proxy (for post writer)
// =============================================
app.post('/api/generate', async (req, res) => {
  try {
    const data = await callAnthropic(
      req.body.system || '',
      req.body.messages?.[0]?.content || '',
      req.body.max_tokens || 4000
    );
    res.json(data);
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: LinkedIn profile from CV (framework)
// =============================================
app.post('/api/profile', async (req, res) => {
  const { cvText, language } = req.body;
  if (!cvText) return res.status(400).json({ error: 'No CV text provided' });

  const langInstruction = language && language !== 'en'
    ? `\n\nIMPORTANT: The user writes in ${language}. Generate ALL output in ${language}.`
    : '';

  const aboutExtra = `

CRITICAL OUTPUT FORMAT REQUIREMENT:
You MUST output ALL sections using these EXACT headers on their own line (no markdown, no ##, no **):

HEADLINE
ABOUT — NARRATIVE
ABOUT — STRUCTURED
WORK EXPERIENCE
SKILLS
LANGUAGES
PROJECTS
EDUCATION
CERTIFICATIONS
RECOMMENDATIONS STRATEGY
FEATURED SECTION
PROFILE PHOTO AND BANNER
CUSTOM URL

For the About section, you MUST generate TWO separate variants with the EXACT headers above:

ABOUT — NARRATIVE
(Write flowing paragraphs here. Hook, origin story, what you do, competencies, CTA. Conversational tone.)

ABOUT — STRUCTURED
(Same content, reformatted for quick scanning:)
- Short intro: 2 sentences max
- "What I do:" with 3-4 concise bullet points
- "How I can help:" or "Ask me about:" with 2-3 bullets
- Brief CTA: 1 sentence
No storytelling. Short sentences. Compact and scannable.

BOTH About variants are mandatory. Do not skip the structured one. Do not merge them.`;

  const systemPrompt = FRAMEWORK_PROMPT + aboutExtra + langInstruction;

  try {
    const data = await callAnthropic(systemPrompt, `Analyze this CV and generate a complete optimized LinkedIn profile:\n\n${cvText}`, 8000);
    res.json(data);
  } catch (err) {
    console.error('Profile error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: Influencer Finder — main endpoint
// =============================================
app.post('/api/influencers', async (req, res) => {
  const { niche, role, goal } = req.body;
  if (!niche) return res.status(400).json({ error: 'Niche is required' });

  try {
    // Step 0: Check cache
    const cached = await getCachedNiche(niche);
    if (cached) {
      console.log(`Cache hit for niche: ${niche}`);
      return res.json({
        profiles: JSON.parse(cached.profiles),
        posts: JSON.parse(cached.posts),
        fromCache: true,
      });
    }

    console.log(`Cache miss for niche: ${niche}. Starting Apify scrape...`);

    // Step 1: Search for profiles in this niche
    const searchResults = await runApifyActor('harvestapi~linkedin-profile-search', {
      searchUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(niche + ' influencer creator')}&origin=GLOBAL_SEARCH_HEADER`,
      maxProfiles: 60,
      scrapeProfiles: true,
    });

    if (!searchResults || searchResults.length === 0) {
      throw new Error('No profiles found for this niche. Try different keywords.');
    }

    // Sort by followers, take top 20
    const sorted = searchResults
      .filter(p => p.fullName && p.profileUrl)
      .map(p => ({
        name: p.fullName || '',
        title: p.headline || p.title || '',
        profileUrl: p.profileUrl || p.url || '',
        followers: parseInt(p.followersCount || p.followers || 0),
        location: p.location || '',
        connections: p.connectionsCount || 0,
      }))
      .sort((a, b) => b.followers - a.followers)
      .slice(0, 20);

    // Step 2: Scrape posts from top 10 profiles (by followers)
    const topForPosts = sorted.slice(0, 10);
    const profileUrls = topForPosts.map(p => p.profileUrl).filter(Boolean);

    let allPosts = [];
    if (profileUrls.length > 0) {
      const postResults = await runApifyActor('harvestapi~linkedin-profile-posts', {
        profileUrls: profileUrls,
        maxPosts: 10, // 10 posts per profile
      });

      if (postResults && postResults.length > 0) {
        allPosts = postResults
          .filter(p => p.text || p.postText || p.content)
          .map(p => ({
            authorName: p.authorName || p.author?.name || '',
            authorUrl: p.authorProfileUrl || p.author?.url || '',
            text: (p.text || p.postText || p.content || '').slice(0, 500),
            likes: parseInt(p.likesCount || p.reactions || p.numLikes || 0),
            comments: parseInt(p.commentsCount || p.numComments || 0),
            reposts: parseInt(p.repostsCount || p.numReposts || 0),
            postUrl: p.postUrl || p.url || '',
            postedAt: p.postedAt || p.publishedAt || '',
          }))
          .map(p => ({ ...p, engagement: p.likes + p.comments * 3 + p.reposts * 2 }))
          .sort((a, b) => b.engagement - a.engagement)
          .slice(0, 50);
      }
    }

    // Save to cache
    await saveNicheCache(niche, sorted, allPosts);

    res.json({
      profiles: sorted,
      posts: allPosts,
      fromCache: false,
    });

  } catch (err) {
    console.error('Influencer search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: Generate post ideas from scraped data
// =============================================
app.post('/api/post-ideas', async (req, res) => {
  const { niche, role, goal, topPosts, profiles } = req.body;

  const topPostsSummary = (topPosts || []).slice(0, 20).map((p, i) =>
    `Post ${i + 1} (${p.likes} likes, ${p.comments} comments, ${p.reposts} reposts) by ${p.authorName}:\n"${p.text.slice(0, 300)}"\nURL: ${p.postUrl}`
  ).join('\n\n');

  const profilesSummary = (profiles || []).slice(0, 10).map(p =>
    `${p.name} — ${p.title} (${p.followers.toLocaleString()} followers)`
  ).join('\n');

  const systemPrompt = `You are a LinkedIn content strategist. You analyze top-performing posts from real influencers and generate post ideas tailored to a user's niche, role, and goal.

Return ONLY a raw JSON array (no markdown, no backticks) of exactly 15 post idea objects:
[
  {
    "hook": "The opening line of the post",
    "why": "Why this will work — reference which influencer post inspired it",
    "format": "Carousel / Story / List / How-to / Opinion / Hot Take / Thread",
    "reference_post_url": "URL of the inspiring post or empty string",
    "reference_author": "Name of the influencer whose post inspired this"
  }
]

Rules:
- Each idea MUST be inspired by a real top-performing post from the data provided
- Adapt the pattern/angle to the user's niche, don't copy the topic
- Vary formats: mix tactical, personal story, opinion, educational, hot takes
- Hooks must stop the scroll — first line is everything on LinkedIn
- Reference the actual post URL when possible`;

  const userMsg = `Niche: ${niche}
${role ? `Role: ${role}` : ''}
${goal ? `Goal: ${goal}` : ''}

TOP INFLUENCERS IN THIS NICHE:
${profilesSummary}

TOP-PERFORMING POSTS (ranked by engagement):
${topPostsSummary}

Generate 15 post ideas inspired by what's actually working in this niche.`;

  try {
    const data = await callAnthropic(systemPrompt, userMsg, 4000);
    const text = data.content[0].text;
    const cleaned = text.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
    const ideas = JSON.parse(cleaned);
    res.json({ ideas });
  } catch (err) {
    console.error('Post ideas error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
