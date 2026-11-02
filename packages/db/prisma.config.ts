import {defineConfig} from 'prisma/config';
export default defineConfig({schema:'prisma/schema.prisma',migrations:{path:'prisma/migrations'},datasource:{url:process.env.DIRECT_URL??'postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/lyraseo_test'}});
