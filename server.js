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

// Helper: call Anthropic API
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

// Generic proxy endpoint (for post writer)
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

// LinkedIn profile generation from CV (uses full framework)
app.post('/api/profile', async (req, res) => {
  const { cvText, language } = req.body;
  if (!cvText) return res.status(400).json({ error: 'No CV text provided' });

  const langInstruction = language && language !== 'en'
    ? `\n\nIMPORTANT: The user writes in ${language}. Generate ALL output in ${language}. Match the user's language exactly.`
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
