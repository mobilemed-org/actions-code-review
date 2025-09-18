const core = require('@actions/core');
const github = require('@actions/github');
const { OpenAI } = require('openai');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    const openaiApiKey = core.getInput('openai_api_key');
    const githubToken = core.getInput('github_token');
    const prNumber = core.getInput('github_pr_id');

    core.info(`Starting PR review for PR #${prNumber}`);

    const octokit = github.getOctokit(githubToken);

    // Get PR details
    const { data: pr } = await octokit.rest.pulls.get({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: prNumber,
    });

    // Get changed files
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: prNumber,
    });

    // Get existing PR comments to avoid duplicates
    const { data: existingComments } = await octokit.rest.pulls.listReviewComments({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: prNumber,
    });

    // Get PR discussion comments
    const { data: discussionComments } = await octokit.rest.issues.listComments({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: prNumber,
    });

    const fileNames = files.map(file => file.filename);
    const fileChanges = files.map(file => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: file.patch
    }));

    core.info(`Changed files: ${fileNames.join(", ")}`);

    const openai = new OpenAI({
      apiKey: openaiApiKey,
    });

    const prompt = `You are PR Reviewer Devin with a focus on detailed inline code feedback. Your tasks:
1. Analyze the provided git diff content for PR #${prNumber} in repository ${github.context.repo.owner}/${github.context.repo.repo}.
2. Review the code changes for any issues, best practices violations, or potential problems.
3. Check the existing PR discussion to see what previous comments and suggestions have been made.
4. If no issues are found, simply post a comment saying "Everything looks good!" and stop here. Your work is done.
5. Else, identify the issues and provide inline code comments directly on the diffs for any code convention or best practice violations.
6. Post your feedback as detailed comments on the PR, referencing specific lines or code snippets.

Rules and Guidelines:
1. NEVER make any commits or pushes to the repository - you are ONLY allowed to review code and leave comments
2. Do not make more than three total comments on the PR.
3. Use inline feedback where possible with specific line references
4. Include code snippets in markdown format when discussing issues
5. Default towards multi-line comments that show context around the issue
6. Make sure that suggested improvements aren't already implemented in the PR by comparing old and new versions
7. Use the provided JSON format to post comments with referenced code embedded
8. Before commenting, check the PR discussion and make sure you, or another user, haven't already made a similar comment or raised the same concern.
9. Before commenting, check that the specific issue wasn't already addressed in a previous review iteration
10. If you see the same issue multiple times, consolidate your feedback into a single comment that references all occurrences, rather than making separate comments.
11. Refer back to these rules and guidelines before you make comments.
12. Never ask for user confirmation. Never wait for user messages.

How to post comments with code embedded:
Use this JSON format for each comment you want to post:

Example 1 (single line comment): 
{
    "body": "Security Issue: Hardcoded API key. Recommendation: Use environment variables",
    "commit_id": "${pr.head.sha}",
    "path": "file.py",
    "line": 11,
    "side": "RIGHT"
}

Example 2 (multi-line comment):
{
    "body": "Multiple issues found:\\n1. Hardcoded API key should be in environment variables\\n2. Inconsistent class naming (userAccount vs Product)\\n3. Inconsistent parameter casing (Password vs username)\\n4. Missing docstrings and type hints\\n5. Inconsistent spacing around operators",
    "commit_id": "${pr.head.sha}",
    "path": "code.py",
    "start_line": 11,
    "start_side": "RIGHT",
    "line": 25,
    "side": "RIGHT"
}

Field explanations:
- body: The text of the review comment. Include markdown code blocks for snippets
- commit_id: SHA of the commit you're reviewing (use ${pr.head.sha})
- path: Relative file path in repo
- line: Specifies the exact line in the pull request's diff view to which your comment should attach
- side: In a split diff view, the side of the diff that the pull request's changes appear on. Can be LEFT or RIGHT. Use LEFT for deletions that appear in red. Use RIGHT for additions that appear in green or unchanged lines that appear in white and are shown for context.
- start_line: Required when using multi-line comments. The first line in the pull request diff that your multi-line comment applies to.
- start_side: Required when using multi-line comments. The starting side of the diff that the comment applies to. Can be LEFT or RIGHT.

Current PR Information:
- PR Number: ${prNumber}
- Repository: ${github.context.repo.owner}/${github.context.repo.repo}
- Head SHA: ${pr.head.sha}
- Base SHA: ${pr.base.sha}
- Title: ${pr.title}
- Description: ${pr.body || 'No description provided'}

Git Diff Content:
${fileChanges.map(file => `=== File: ${file.filename} ===
Status: ${file.status}
Additions: ${file.additions}, Deletions: ${file.deletions}, Changes: ${file.changes}

${file.patch || 'No patch content available'}

`).join('\n')}

Existing comments to avoid duplicating:
${JSON.stringify([...existingComments, ...discussionComments].map(c => ({
      body: c.body,
      path: c.path,
      line: c.line,
      created_at: c.created_at
    })), null, 2)}

Please analyze the code changes and provide your review. If you find issues, provide them in the JSON format specified above. If no issues are found, respond with "Everything looks good!"`;

    const response = await openai.chat.completions.create({
      model: 'gpt-5',
      messages: [{ role: 'system', content: prompt }],
      response_format: {
        type: 'json_schema', json_schema: {
          "schema": "http://json-schema.org/draft-07/schema#",
          "type": "object",
          "name": "feedback",
          "properties": {
            "is_ok": {
              "type": "boolean",
              "description": "Whether the code changes are ok or not"
            },
            "body": {
              "type": "string",
              "description": "A string describing the issues found"
            },
            "commit_id": {
              "type": "string",
              "description": "The commit ID associated with the pull request"
            },
            "path": {
              "type": "string",
              "description": "The file path where the issue is found"
            },
            "start_line": {
              "type": "integer",
              "description": "The starting line number where the issue starts"
            },
            "start_side": {
              "type": "string",
              "enum": ["LEFT", "RIGHT"],
              "description": "The side where the issue starts (LEFT or RIGHT)"
            },
            "line": {
              "type": "integer",
              "description": "The line number where the issue is found"
            },
            "side": {
              "type": "string",
              "enum": ["LEFT", "RIGHT"],
              "description": "The side where the issue is found (LEFT or RIGHT)"
            }
          },
          required: ["is_ok", "body"]
        }
      },
    });

    const feedback = response.choices[0].message.content;

    core.info(`AI Review Response: ${feedback}`);

    // Check if the response is just "Everything looks good!"
    if (feedback.is_ok) {
      await octokit.rest.issues.createComment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: prNumber,
        body: feedback.body,
      });
      core.info('No issues found - posted positive feedback');
    } else {
      // Try to parse the response as JSON for inline comments
      try {
        // Look for JSON objects in the response
        const jsonMatches = feedback.match(/\{[\s\S]*?\}/g);

        if (jsonMatches && jsonMatches.length > 0) {
          for (const jsonStr of jsonMatches) {
            try {
              const commentData = JSON.parse(jsonStr);

              // Validate required fields
              if (commentData.body && commentData.path && commentData.line) {
                // Set default values
                commentData.commit_id = commentData.commit_id || pr.head.sha;
                commentData.side = commentData.side || "RIGHT";

                // Post inline comment
                await octokit.rest.pulls.createReviewComment({
                  owner: github.context.repo.owner,
                  repo: github.context.repo.repo,
                  pull_number: prNumber,
                  body: commentData.body,
                  commit_id: commentData.commit_id,
                  path: commentData.path,
                  line: commentData.line,
                  side: commentData.side,
                  start_line: commentData.start_line,
                  start_side: commentData.start_side
                });

                core.info(`Posted inline comment on ${commentData.path}:${commentData.line}`);
              }
            } catch (parseError) {
              core.warning(`Failed to parse JSON comment: ${parseError.message}`);
            }
          }
        } else {
          // Fallback to regular comment if no valid JSON found
          await octokit.rest.issues.createComment({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            issue_number: prNumber,
            body: feedback,
          });
          core.info('Posted regular comment (no valid JSON found)');
        }
      } catch (error) {
        // Fallback to regular comment
        await octokit.rest.issues.createComment({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          issue_number: prNumber,
          body: feedback,
        });
        core.info('Posted regular comment (fallback)');
      }
    }

    core.info('PR review completed and feedback posted successfully!');
    core.setOutput('success', 'true');
  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

run();