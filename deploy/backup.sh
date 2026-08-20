#!/bin/sh
# Целостный снимок базы + выгрузка в Yandex Object Storage.
# VACUUM INTO, в отличие от cp, забирает и WAL и не может дать рваный файл.
# Ключи S3 — в /root/.s3cred (S3_KEY, S3_SECRET), права 600.
set -e
. /root/.s3cred
DIR=/opt/yclients-crm/data
DAY=$(date +%F)
OUT="$DIR/backup-$DAY.db"
rm -f "$OUT" "$OUT.gz"
node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('$DIR/crm.db').exec(\"VACUUM INTO '$OUT'\")"
gzip -c "$OUT" > "$OUT.gz"
curl -fsS --aws-sigv4 "aws:amz:ru-central1:s3" --user "$S3_KEY:$S3_SECRET" \
  -T "$OUT.gz" "https://storage.yandexcloud.net/prive7-crm-backup/crm-$DAY.db.gz"
rm -f "$OUT.gz"
find "$DIR" -name 'backup-2*.db' -mtime +30 -delete
