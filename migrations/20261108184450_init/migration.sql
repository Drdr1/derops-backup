-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('FREE', 'BASIC', 'GROW', 'ADVANCED');

-- CreateEnum
CREATE TYPE "DestinationKind" AS ENUM ('MANAGED', 'S3');

-- CreateEnum
CREATE TYPE "SnapshotKind" AS ENUM ('FULL', 'MANUAL', 'INCREMENTAL');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('PRODUCT', 'COLLECTION', 'THEME_FILE', 'FILE', 'METAOBJECT_DEFINITION', 'METAOBJECT', 'MENU', 'PAGE', 'BLOG', 'ARTICLE', 'DISCOUNT', 'SHOP_POLICY', 'INVENTORY_LEVEL');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('BACKUP_FULL', 'BACKUP_INCREMENTAL', 'RESTORE_ITEM', 'RESTORE_THEME', 'VERIFY_DESTINATION', 'PRUNE_RETENTION');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'FREE',
    "shopifyPlan" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "scheduleCron" TEXT NOT NULL DEFAULT '0 3 * * *',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "notifyEmail" TEXT,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Destination" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" "DestinationKind" NOT NULL,
    "label" TEXT NOT NULL,
    "endpoint" TEXT,
    "region" TEXT,
    "bucket" TEXT,
    "prefix" TEXT,
    "accessKeyEnc" TEXT,
    "secretKeyEnc" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Destination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "kind" "SnapshotKind" NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "manifestKey" TEXT,
    "bytesWritten" BIGINT NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "changedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "apiVersion" TEXT,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnapshotItem" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "resource" "ResourceType" NOT NULL,
    "shopifyGid" TEXT NOT NULL,
    "title" TEXT,
    "contentHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "changed" BOOLEAN NOT NULL DEFAULT true,
    "deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SnapshotItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "Shop_uninstalledAt_idx" ON "Shop"("uninstalledAt");

-- CreateIndex
CREATE INDEX "Destination_shopId_idx" ON "Destination"("shopId");

-- CreateIndex
CREATE INDEX "Snapshot_shopId_startedAt_idx" ON "Snapshot"("shopId", "startedAt");

-- CreateIndex
CREATE INDEX "SnapshotItem_snapshotId_resource_idx" ON "SnapshotItem"("snapshotId", "resource");

-- CreateIndex
CREATE INDEX "SnapshotItem_shopifyGid_idx" ON "SnapshotItem"("shopifyGid");

-- CreateIndex
CREATE INDEX "Job_shopId_createdAt_idx" ON "Job"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- AddForeignKey
ALTER TABLE "Destination" ADD CONSTRAINT "Destination_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "Destination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotItem" ADD CONSTRAINT "SnapshotItem_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "Snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
