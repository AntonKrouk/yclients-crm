#!/bin/sh
# Целостный снимок базы + выгрузка в ДВА хранилища: Yandex Object Storage (основное)
# и Timeweb S3 (запасное, на случай сбоя у Яндекса). VACUUM INTO, в отличие от cp,
# забирает и WAL и не может дать рваный файл.
# Ключи: /root/.s3cred (S3_KEY, S3_SECRET — Яндекс) и /root/.s3cred-tw
# (TW_KEY, TW_SECRET, TW_BUCKET — Timeweb), оба с правами 600.
# Нет файла Timeweb — работает как раньше, только с Яндексом.
# Сбой одного хранилища не мешает второму; код выхода ненулевой, если что-то не ушло.
set -e
. /root/.s3cred
[ -f /root/.s3cred-tw ] && . /root/.s3cred-tw
DIR=/opt/yclients-crm/data
DAY=$(date +%F)
OUT="$DIR/backup-$DAY.db"
FAIL=0
rm -f "$OUT" "$OUT.gz"
node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync('$DIR/crm.db').exec(\"VACUUM INTO '$OUT'\")"
gzip -c "$OUT" > "$OUT.gz"

# put <файл> <имя в бакете>: кладёт в оба хранилища, ошибку запоминает и идёт дальше.
put() {
  curl -fsS --aws-sigv4 "aws:amz:ru-central1:s3" --user "$S3_KEY:$S3_SECRET" \
    -T "$1" "https://storage.yandexcloud.net/prive7-crm-backup/$2" || { echo "YANDEX FAIL $2"; FAIL=1; }
  if [ -n "$TW_KEY" ]; then
    curl -fsS --aws-sigv4 "aws:amz:ru-1:s3" --user "$TW_KEY:$TW_SECRET" \
      -T "$1" "https://s3.twcstorage.ru/$TW_BUCKET/$2" || { echo "TIMEWEB FAIL $2"; FAIL=1; }
  fi
}

put "$OUT.gz" "crm-$DAY.db.gz"
rm -f "$OUT.gz"
find "$DIR" -name 'backup-2*.db' -mtime +30 -delete

# Фото витрины (портрет мастера, портфолио) лежат файлами, не в базе. Архив по дню недели:
# в бакете всегда 7 последних копий, место не растёт.
if [ -d "$DIR/portfolio" ]; then
  WD=$(date +%u)
  tar -czf "$DIR/portfolio-$WD.tar.gz" -C "$DIR" portfolio
  put "$DIR/portfolio-$WD.tar.gz" "portfolio-$WD.tar.gz"
  rm -f "$DIR/portfolio-$WD.tar.gz"
fi

# Старые crm-*.db.gz в бакетах сами не удаляются (в Яндексе так же): чистить правилом
# жизненного цикла в панели Timeweb (хранить 30 дней) или руками.
exit $FAIL
