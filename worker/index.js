/**
 * LaFloraison Course Generator — Cloudflare Worker
 *
 * 接收前端请求 → 拉取 GitHub 上的 CLAUDE.md + skill 指令
 * → 调用 DeepSeek API 流式生成 → SSE 推回前端
 * → 可选：生成完成后自动提交到 GitHub
 */

/* ══════════════════════════════════════════
   CONFIG — Project definitions
   ══════════════════════════════════════════ */

const PROJECTS = {
  roadofcs: {
    repo: 'LaFloraison/RoadOfCS',
    branch: 'main',
    claudeMd: 'CLAUDE.md',
    skillsDir: '.claude/skills',
    lessonsDir: 'lessons/408-history',
    curriculumMd: 'curriculum/408-history/curriculum-design.md',
    fileTypes: {
      '主线': { skill: 'narrative-tutor.md', ext: '.md' },
      '前沿': { skill: 'frontier-tutor.md', ext: '.md' },
      '习题': { skill: 'exercise-tutor.md', ext: '.md' },
      '镜鉴': { skill: 'mirror-tutor.md', ext: '.md' },
      '深入': { skill: 'deep-dive.md', ext: '.md', needsTopic: true }
    }
  },
  math5all: {
    repo: 'LaFloraison/Math5All',
    branch: 'main',
    claudeMd: 'CLAUDE.md',
    skillsDir: '.claude/skills',
    lessonsDir: 'lessons/calculus',
    fileTypes: {
      '数学': { skill: 'math-tutor.md', ext: '.md' },
      '应用': { skill: 'application-tutor.md', ext: '.md' },
      '习题': { skill: 'exercise-tutor.md', ext: '.md' },
      '谜镜': { skill: 'mirror-tutor.md', ext: '.md' },
      '深入': { skill: 'deep-dive.md', ext: '.md', needsTopic: true }
    }
  }
};

/* ══════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════ */

function ghRaw(project, path) {
  return `https://raw.githubusercontent.com/${project.repo}/${project.branch}/${path}`;
}

function ghApi(project, path) {
  return `https://api.github.com/repos/${project.repo}/contents/${path}`;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/* ══════════════════════════════════════════
   MAIN HANDLER
   ══════════════════════════════════════════ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    /* CORS preflight */
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || origin || '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || origin || '*'
    };

    /* ── GET /api/projects — List available projects ── */
    if (url.pathname === '/api/projects' && request.method === 'GET') {
      const list = Object.entries(PROJECTS).map(([id, p]) => ({
        id,
        repo: p.repo,
        fileTypes: Object.keys(p.fileTypes)
      }));
      return jsonResponse({ projects: list }, 200, corsHeaders);
    }

    /* ── POST /api/generate — Start generation (SSE stream) ── */
    if (url.pathname === '/api/generate' && request.method === 'POST') {
      return handleGenerate(request, env, corsHeaders);
    }

    /* ── POST /api/commit — Save generated content to GitHub ── */
    if (url.pathname === '/api/commit' && request.method === 'POST') {
      return handleCommit(request, env, corsHeaders);
    }

    return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
  }
};

/* ══════════════════════════════════════════
   GENERATE — Stream DeepSeek response via SSE
   ══════════════════════════════════════════ */

async function handleGenerate(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const { project: projectId, lessonId, fileType, topic } = body;
  if (!projectId || !lessonId || !fileType) {
    return jsonResponse({ error: 'Missing required fields: project, lessonId, fileType' }, 400, corsHeaders);
  }

  const project = PROJECTS[projectId];
  if (!project) return jsonResponse({ error: `Unknown project: ${projectId}` }, 400, corsHeaders);

  const ft = project.fileTypes[fileType];
  if (!ft) return jsonResponse({ error: `Unknown fileType: ${fileType} for ${projectId}` }, 400, corsHeaders);

  if (ft.needsTopic && !topic) {
    return jsonResponse({ error: `深入探索需要指定 topic` }, 400, corsHeaders);
  }

  /* Check API key */
  if (!env.DEEPSEEK_API_KEY) {
    return jsonResponse({ error: 'Worker not configured: DEEPSEEK_API_KEY missing' }, 500, corsHeaders);
  }

  /* ── Build prompt ── */
  let systemPrompt;
  try {
    systemPrompt = await buildSystemPrompt(project, ft, topic);
  } catch (e) {
    return jsonResponse({ error: `Failed to load instructions: ${e.message}` }, 500, corsHeaders);
  }

  const userPrompt = buildUserPrompt(project, lessonId, fileType, topic);

  /* ── Call DeepSeek API (streaming) ── */
  const deepseekRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      stream: true,
      temperature: 0.7,
      max_tokens: 32768
    })
  });

  if (!deepseekRes.ok) {
    const errText = await deepseekRes.text();
    return jsonResponse({ error: `DeepSeek API error: ${deepseekRes.status} — ${errText}` }, 502, corsHeaders);
  }

  /* ── Stream SSE back to client ── */
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  ctx.waitUntil(pipeStream(deepseekRes.body, writer, encoder));

  return new Response(readable, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

async function pipeStream(deepseekBody, writer, encoder) {
  try {
    const reader = deepseekBody.getReader();
    let fullContent = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += new TextDecoder().decode(value);
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            await writer.write(encoder.encode(sseEvent({ type: 'token', content: delta })));
          }
        } catch (e) {
          /* Skip unparseable lines */
        }
      }
    }

    /* Send final event with complete content */
    await writer.write(encoder.encode(sseEvent({ type: 'done', fullContent })));
  } catch (e) {
    await writer.write(encoder.encode(sseEvent({ type: 'error', message: e.message })));
  } finally {
    await writer.close();
  }
}

/* ══════════════════════════════════════════
   COMMIT — Save generated content to GitHub
   ══════════════════════════════════════════ */

async function handleCommit(request, env, corsHeaders) {
  if (!env.GITHUB_TOKEN) {
    return jsonResponse({ error: 'GITHUB_TOKEN not configured' }, 500, corsHeaders);
  }

  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const { project: projectId, lessonId, fileType, content, topic } = body;
  if (!projectId || !lessonId || !fileType || !content) {
    return jsonResponse({ error: 'Missing required fields' }, 400, corsHeaders);
  }

  const project = PROJECTS[projectId];
  if (!project) return jsonResponse({ error: `Unknown project: ${projectId}` }, 400, corsHeaders);

  /* Determine file path */
  const ft = project.fileTypes[fileType];
  let fileName;
  if (fileType === '深入' && topic) {
    fileName = `${topic}.md`;
    /* Actually, for deep dives the naming convention varies. Use topic + .md */
    const safeName = topic.replace(/[^a-zA-Z0-9一-鿿_-]/g, '-');
    fileName = `${safeName}.md`;
  } else {
    fileName = `${fileType}.md`;
  }

  /* Need to determine the folder name. */
  /* For simplicity, accept a folderHint from frontend */
  const folderHint = body.folderName || lessonId;
  const safeFolder = encodeURIComponent(folderHint);
  const filePath = `${project.lessonsDir}/${safeFolder}/${fileName}`;

  /* Check if file exists (to decide PUT vs no-op for new) */
  /* We always PUT — GitHub API creates or updates */
  const apiUrl = `https://api.github.com/repos/${project.repo}/contents/${filePath}`;

  /* Get current SHA if file exists */
  let sha = null;
  try {
    const check = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (check.ok) {
      const existing = await check.json();
      sha = existing.sha;
    }
  } catch (e) { /* File doesn't exist — that's fine */ }

  /* Commit the file */
  const commitRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json'
    },
    body: JSON.stringify({
      message: `📱 手机端生成: ${fileType} — ${lessonId}${topic ? ' → ' + topic : ''}`,
      content: btoa(unescape(encodeURIComponent(content))),
      branch: project.branch,
      ...(sha ? { sha } : {})
    })
  });

  if (!commitRes.ok) {
    const errText = await commitRes.text();
    return jsonResponse({ error: `GitHub commit failed: ${commitRes.status} — ${errText}`, filePath }, 502, corsHeaders);
  }

  const result = await commitRes.json();
  return jsonResponse({
    success: true,
    filePath,
    commitUrl: result.commit?.html_url,
    message: `已保存到 ${filePath}`
  }, 200, corsHeaders);
}

/* ══════════════════════════════════════════
   PROMPT ASSEMBLY
   ══════════════════════════════════════════ */

async function buildSystemPrompt(project, fileType, topic) {
  /* Load CLAUDE.md + skill file */
  const [claudeMd, skillMd] = await Promise.all([
    fetchText(ghRaw(project, project.claudeMd)).catch(() => ''),
    fetchText(ghRaw(project, `${project.skillsDir}/${fileType.skill}`)).catch(() => '')
  ]);

  if (!claudeMd && !skillMd) {
    throw new Error('Could not load any instruction files');
  }

  let prompt = '';

  if (claudeMd) {
    prompt += `你是一位计算机科学导师。请严格遵循以下教学哲学和风格指南：\n\n${claudeMd}\n\n---\n\n`;
  }

  if (skillMd) {
    prompt += `请严格按照以下生成指令执行本次任务：\n\n${skillMd}\n\n---\n\n`;
  }

  prompt += '请只输出最终的课程内容（Markdown格式），不要包含任何元对话或解释。';

  return prompt;
}

function buildUserPrompt(project, lessonId, fileType, topic) {
  let prompt = `请为以下课程节点生成内容：\n\n`;
  prompt += `- 项目：${project.repo}\n`;
  prompt += `- 课程节点：${lessonId}\n`;
  prompt += `- 生成类型：${fileType}\n`;

  if (topic) {
    prompt += `- 深入主题：${topic}\n`;
  }

  prompt += `\n请开始生成。注意控制篇幅和结构，使内容适合移动端阅读。`;

  return prompt;
}

/* ══════════════════════════════════════════
   RESPONSE helper with CORS
   ══════════════════════════════════════════ */

function jsonResponse(data, status, extraHeaders) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(extraHeaders || {})
    }
  });
}
