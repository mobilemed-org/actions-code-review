const core = require('@actions/core');
const github = require('@actions/github');
const { OpenAI } = require('openai');

async function run() {
  try {
    const openaiApiKey = core.getInput('openai_api_key');
    const githubToken = core.getInput('github_token');
    const prNumber = core.getInput('github_pr_id');

    core.info(`OpenAI API Key: ${openaiApiKey}`);
    core.info(`GitHub Token: ${githubToken}`);
    core.info(`PR Number: ${prNumber}`);
    
    const octokit = github.getOctokit(githubToken);

    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: prNumber,
    });

    const fileNames = files.map(file => file.filename);

    const openai = new OpenAI({
      apiKey: openaiApiKey,
    });

    const prompt = `Review the following files: ${fileNames.join(", ")}. Provide inline comments and feedback on potential issues or improvements.`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'system', content: prompt }],
    });

    const feedback = response.choices[0].message.content;

    core.info(`Feedback: ${feedback}`);

    await octokit.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: prNumber,
      body: feedback,
    });

    core.info('PR review completed and feedback posted successfully!');
    core.setOutput('success', 'true');
  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

run();