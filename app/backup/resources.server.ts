import type { ResourceType } from "@prisma/client";

/**
 * Resource definitions for Phase 1 bulk backups.
 * Each entry: the bulk GraphQL query (no pagination args — Bulk Operations handle that)
 * and how to fold flattened child lines back into their parent.
 */
export type ResourceDef = {
  type: ResourceType;
  file: string; // file name inside the snapshot folder
  query: string;
  childKeys: Record<string, string>; // __typename -> array name on parent
  titleOf: (o: Record<string, unknown>) => string | undefined;
};

export const PRODUCTS: ResourceDef = {
  type: "PRODUCT",
  file: "products.jsonl",
  childKeys: {
    ProductVariant: "variants",
    MediaImage: "media",
    Video: "media",
    Model3d: "media",
    ExternalVideo: "media",
    Metafield: "metafields",
    ProductOption: "options",
  },
  titleOf: (o) => o.title as string | undefined,
  query: `#graphql
  {
    products {
      edges {
        node {
          id
          __typename
          legacyResourceId
          handle
          title
          descriptionHtml
          vendor
          productType
          status
          tags
          templateSuffix
          publishedAt
          createdAt
          updatedAt
          seo { title description }
          category { id fullName }
          options {
            id
            __typename
            name
            position
            values
          }
          variants {
            edges {
              node {
                id
                __typename
                legacyResourceId
                title
                sku
                barcode
                price
                compareAtPrice
                position
                taxable
                taxCode
                inventoryPolicy
                inventoryQuantity
                selectedOptions { name value }
                inventoryItem {
                  id
                  tracked
                  requiresShipping
                  measurement { weight { value unit } }
                  unitCost { amount currencyCode }
                }
                image { id url altText }
              }
            }
          }
          media {
            edges {
              node {
                id
                __typename
                alt
                mediaContentType
                status
                ... on MediaImage { image { url width height } }
                ... on Video { originalSource { url } }
                ... on ExternalVideo { originUrl }
                ... on Model3d { originalSource { url } }
              }
            }
          }
          metafields {
            edges {
              node {
                id
                __typename
                namespace
                key
                type
                value
              }
            }
          }
        }
      }
    }
  }`,
};

export const COLLECTIONS: ResourceDef = {
  type: "COLLECTION",
  file: "collections.jsonl",
  childKeys: { Metafield: "metafields", Product: "products" },
  titleOf: (o) => o.title as string | undefined,
  query: `#graphql
  {
    collections {
      edges {
        node {
          id
          __typename
          legacyResourceId
          handle
          title
          descriptionHtml
          sortOrder
          templateSuffix
          updatedAt
          image { url altText }
          seo { title description }
          ruleSet {
            appliedDisjunctively
            rules { column relation condition }
          }
          products {
            edges { node { id __typename handle } }
          }
          metafields {
            edges { node { id __typename namespace key type value } }
          }
        }
      }
    }
  }`,
};

/** Order matters: one bulk operation at a time per shop. */
export const PHASE1_BULK_RESOURCES: ResourceDef[] = [PRODUCTS, COLLECTIONS];
