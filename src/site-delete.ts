import { deleteSiteRows, listSiteR2Keys } from "./db";

const R2_LIST_PAGE = 1000;
const R2_DELETE_BATCH = 1000;

/**
 * Deletes one site from the HTML UI.
 * R2 objects go first (bill keys and any leftover `sites/<id>/` objects), then
 * the D1 rows. A failed object delete leaves the site in place so the form can
 * be submitted again. A failed row delete can be retried the same way: object
 * deletes are safe to repeat.
 */
export async function deleteSiteCascade(env: Pick<Env, "DB" | "BILLS">, siteId: string): Promise<void> {
  const [fromBills, fromPrefix] = await Promise.all([
    listSiteR2Keys(env.DB, siteId),
    listR2KeysByPrefix(env.BILLS, `sites/${siteId}/`),
  ]);
  await deleteR2Keys(env.BILLS, [...fromBills, ...fromPrefix]);
  await deleteSiteRows(env.DB, siteId);
}

async function listR2KeysByPrefix(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, cursor, limit: R2_LIST_PAGE });
    for (const object of page.objects) keys.push(object.key);
    if (!page.truncated) return keys;
    if (page.objects.length === 0 || page.cursor === cursor) return keys;
    cursor = page.cursor;
  }
}

async function deleteR2Keys(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  const unique = [...new Set(keys.filter((key) => key.length > 0))];
  for (let index = 0; index < unique.length; index += R2_DELETE_BATCH) {
    await bucket.delete(unique.slice(index, index + R2_DELETE_BATCH));
  }
}
