# Home Hub

Home management app for Gennaro & Cristine at home.cristinegennaro.com.

## Stack
- **Frontend**: Next.js (Pages Router) + HeroUI + Tailwind CSS
- **Backend**: AWS Amplify Gen 2 (AppSync, DynamoDB, Lambda)
- **AI Agent**: Anthropic Claude via direct API (not Bedrock)
- **Notifications**: SNS topic (SMS subscriptions added manually in AWS Console)
- **WhatsApp Bot**: ECS Fargate + Baileys (linked device approach)

## AWS
- Amplify App ID: `dkiwlyw3k1yfi`
- Region: `us-east-1`
- S3 bucket (shared with wedding site): `cristinegennaro.com`

## Key decisions
- Auth uses Cognito `home-users` group for all home models
- Agent Lambda invoked via AppSync custom mutation (not Lambda Function URL — blocked by account-level public access policy)
- Recurring tasks: on-completion creates next occurrence + daily EventBridge sweep as safety net
- WhatsApp bot uses Baileys (not official WA Business API) because it needs group chat support
- WA bot desiredCount is 0 until first Docker image is pushed to ECR

## Dev
- `npx ampx sandbox --profile amplify-dev` to run backend locally
- `npm run dev` for frontend (port 3001)
- `.env.local` holds `ANTHROPIC_API_KEY`
- `npm install` requires `--legacy-peer-deps` (handled by `.npmrc`)
