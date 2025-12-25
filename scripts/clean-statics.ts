import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { glob } from 'glob';
import * as fs from 'fs';
import * as readline from 'readline';

const R2_CONFIG = {
  accountId: process.env.R2_ACCOUNT_ID || '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucketName: process.env.R2_BUCKET_NAME || '',
};

const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_CONFIG.accountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
});

const STATIC_URL_PATTERN = /https:\/\/static\.katyusha\.me\/([^\s"'`)<]+)/g;

async function scanProjectForUrls(): Promise<Set<string>> {
  const referencedPaths = new Set<string>();
  
  const files = await glob('**/*.{ts,tsx,js,jsx,vue,html,css,scss,json,md}', {
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      '**/dist-ssr/**',
      '**/.idea/**',
    ],
  });

  console.log(`找到 ${files.length} 个文件待扫描`);

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const matches = content.matchAll(STATIC_URL_PATTERN);
      
      for (const match of matches) {
        const fullPath = match[1];
        referencedPaths.add(fullPath);
      }
    } catch (error) {
      console.warn(`    无法读取文件: ${file}`, error);
    }
  }

  console.log(`找到 ${referencedPaths.size} 个被引用的资源`);
  return referencedPaths;
}

async function listAllR2Objects(): Promise<string[]> {
  const allObjects: string[] = [];
  let continuationToken: string | undefined;

  do {
    const command = new ListObjectsV2Command({
      Bucket: R2_CONFIG.bucketName,
      ContinuationToken: continuationToken,
    });

    const response = await r2Client.send(command);
    
    if (response.Contents) {
      for (const obj of response.Contents) {
        if (obj.Key) {
          allObjects.push(obj.Key);
        }
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  console.log(`R2中共有 ${allObjects.length} 个对象`);
  return allObjects;
}

async function deleteUnreferencedObjects(
  r2Objects: string[],
  referencedPaths: Set<string>
): Promise<void> {
  const toDelete = r2Objects.filter(obj => !referencedPaths.has(obj));
  
  console.log(`\n将删除 ${toDelete.length} 个未引用的对象`);

  if (toDelete.length === 0) {
    console.log('没有需要清理的资源');
    return;
  }

  console.log('\n待删除的对象:');
  toDelete.slice(0, 10).forEach(obj => console.log(`  - https://static.katyusha.me/${obj}`));
  if (toDelete.length > 10) {
    console.log(`  ... 还有 ${toDelete.length - 10} 个`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise(resolve => 
    rl.question('\n确认删除? (yes/no): ', resolve)
  );
  rl.close();
  if (answer !== 'yes') {
    console.log('操作已取消');
    return;
  }

  let deleted = 0;
  let failed = 0;

  for (const objKey of toDelete) {
    try {
      await r2Client.send(
        new DeleteObjectCommand({
          Bucket: R2_CONFIG.bucketName,
          Key: objKey,
        })
      );
      deleted++;
      console.log(`已删除: ${objKey}`);
    } catch (error) {
      failed++;
      console.error(`删除失败: ${objKey}`, error);
    }
  }

  console.log(`\n删除完成: 成功 ${deleted} 个, 失败 ${failed} 个`);
}

async function main() {
  try {
    console.log('清理已上传到 Cloudflare R2，但未被使用的静态资源...\n');

    if (!R2_CONFIG.accountId || !R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey || !R2_CONFIG.bucketName) {
      throw new Error('请配置R2环境变量: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME');
    }

    const referencedPaths = await scanProjectForUrls();

    const r2Objects = await listAllR2Objects();

    await deleteUnreferencedObjects(r2Objects, referencedPaths);

    console.log('清理完成!');
  } catch (error) {
    console.error('错误:', error);
    process.exit(1);
  }
}

main();
