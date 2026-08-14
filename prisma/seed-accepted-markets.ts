/**
 * Seed script for the AcceptedMarket table.
 *
 * Seeds all 50 Nielsen DMAs as accepted markets with default base_concurrency of 1.
 * After seeding, review the list and:
 *   - Set is_active=false for markets where you don't have driver pools
 *   - Increase base_concurrency for markets where you run multiple trucks
 *
 * Usage: npx ts-node prisma/seed-accepted-markets.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TOP_50_DMAS = [
  { rank: 1,  dma_code: "DMA-501", dma_name: "New York, NY",          lat: 40.7128, lng: -74.0060 },
  { rank: 2,  dma_code: "DMA-803", dma_name: "Los Angeles, CA",       lat: 34.0522, lng: -118.2437 },
  { rank: 3,  dma_code: "DMA-602", dma_name: "Chicago, IL",           lat: 41.8781, lng: -87.6298 },
  { rank: 4,  dma_code: "DMA-623", dma_name: "Dallas-Fort Worth, TX", lat: 32.7767, lng: -96.7970 },
  { rank: 5,  dma_code: "DMA-504", dma_name: "Philadelphia, PA",      lat: 39.9526, lng: -75.1652 },
  { rank: 6,  dma_code: "DMA-618", dma_name: "Houston, TX",           lat: 29.7604, lng: -95.3698 },
  { rank: 7,  dma_code: "DMA-524", dma_name: "Atlanta, GA",           lat: 33.7490, lng: -84.3880 },
  { rank: 8,  dma_code: "DMA-511", dma_name: "Washington, DC",        lat: 38.9072, lng: -77.0369 },
  { rank: 9,  dma_code: "DMA-807", dma_name: "San Francisco, CA",     lat: 37.7749, lng: -122.4194 },
  { rank: 10, dma_code: "DMA-506", dma_name: "Boston, MA",            lat: 42.3601, lng: -71.0589 },
  { rank: 11, dma_code: "DMA-539", dma_name: "Tampa, FL",             lat: 27.9506, lng: -82.4572 },
  { rank: 12, dma_code: "DMA-753", dma_name: "Phoenix, AZ",           lat: 33.4484, lng: -112.0740 },
  { rank: 13, dma_code: "DMA-819", dma_name: "Seattle, WA",           lat: 47.6062, lng: -122.3321 },
  { rank: 14, dma_code: "DMA-505", dma_name: "Detroit, MI",           lat: 42.3314, lng: -83.0458 },
  { rank: 15, dma_code: "DMA-534", dma_name: "Orlando, FL",           lat: 28.5383, lng: -81.3792 },
  { rank: 16, dma_code: "DMA-613", dma_name: "Minneapolis, MN",       lat: 44.9778, lng: -93.2650 },
  { rank: 17, dma_code: "DMA-751", dma_name: "Denver, CO",            lat: 39.7392, lng: -104.9903 },
  { rank: 18, dma_code: "DMA-528", dma_name: "Miami, FL",             lat: 25.7617, lng: -80.1918 },
  { rank: 19, dma_code: "DMA-510", dma_name: "Cleveland, OH",         lat: 41.4993, lng: -81.6944 },
  { rank: 20, dma_code: "DMA-862", dma_name: "Sacramento, CA",        lat: 38.5816, lng: -121.4944 },
  { rank: 21, dma_code: "DMA-517", dma_name: "Charlotte, NC",         lat: 35.2271, lng: -80.8431 },
  { rank: 22, dma_code: "DMA-560", dma_name: "Raleigh-Durham, NC",    lat: 35.7796, lng: -78.6382 },
  { rank: 23, dma_code: "DMA-820", dma_name: "Portland, OR",          lat: 45.5152, lng: -122.6784 },
  { rank: 24, dma_code: "DMA-609", dma_name: "St. Louis, MO",         lat: 38.6270, lng: -90.1994 },
  { rank: 25, dma_code: "DMA-659", dma_name: "Nashville, TN",         lat: 36.1627, lng: -86.7816 },
  { rank: 26, dma_code: "DMA-527", dma_name: "Indianapolis, IN",      lat: 39.7684, lng: -86.1581 },
  { rank: 27, dma_code: "DMA-508", dma_name: "Pittsburgh, PA",        lat: 40.4406, lng: -79.9959 },
  { rank: 28, dma_code: "DMA-770", dma_name: "Salt Lake City, UT",    lat: 40.7608, lng: -111.8910 },
  { rank: 29, dma_code: "DMA-512", dma_name: "Baltimore, MD",         lat: 39.2904, lng: -76.6122 },
  { rank: 30, dma_code: "DMA-825", dma_name: "San Diego, CA",         lat: 32.7157, lng: -117.1611 },
  { rank: 31, dma_code: "DMA-641", dma_name: "San Antonio, TX",       lat: 29.4241, lng: -98.4936 },
  { rank: 32, dma_code: "DMA-616", dma_name: "Kansas City, MO",       lat: 39.0997, lng: -94.5786 },
  { rank: 33, dma_code: "DMA-533", dma_name: "Hartford, CT",          lat: 41.7658, lng: -72.6734 },
  { rank: 34, dma_code: "DMA-635", dma_name: "Austin, TX",            lat: 30.2672, lng: -97.7431 },
  { rank: 35, dma_code: "DMA-535", dma_name: "Columbus, OH",          lat: 39.9612, lng: -82.9988 },
  { rank: 36, dma_code: "DMA-567", dma_name: "Greenville, SC",        lat: 34.8526, lng: -82.3940 },
  { rank: 37, dma_code: "DMA-515", dma_name: "Cincinnati, OH",        lat: 39.1031, lng: -84.5120 },
  { rank: 38, dma_code: "DMA-617", dma_name: "Milwaukee, WI",         lat: 43.0389, lng: -87.9065 },
  { rank: 39, dma_code: "DMA-548", dma_name: "West Palm Beach, FL",   lat: 26.7153, lng: -80.0534 },
  { rank: 40, dma_code: "DMA-839", dma_name: "Las Vegas, NV",         lat: 36.1699, lng: -115.1398 },
  { rank: 41, dma_code: "DMA-561", dma_name: "Jacksonville, FL",      lat: 30.3322, lng: -81.6557 },
  { rank: 42, dma_code: "DMA-566", dma_name: "Harrisburg, PA",        lat: 40.2732, lng: -76.8867 },
  { rank: 43, dma_code: "DMA-563", dma_name: "Grand Rapids, MI",      lat: 42.9634, lng: -85.6681 },
  { rank: 44, dma_code: "DMA-544", dma_name: "Norfolk, VA",           lat: 36.8508, lng: -76.2859 },
  { rank: 45, dma_code: "DMA-630", dma_name: "Birmingham, AL",        lat: 33.5186, lng: -86.8104 },
  { rank: 46, dma_code: "DMA-518", dma_name: "Greensboro, NC",        lat: 36.0726, lng: -79.7920 },
  { rank: 47, dma_code: "DMA-650", dma_name: "Oklahoma City, OK",     lat: 35.4676, lng: -97.5164 },
  { rank: 48, dma_code: "DMA-790", dma_name: "Albuquerque, NM",       lat: 35.0844, lng: -106.6504 },
  { rank: 49, dma_code: "DMA-529", dma_name: "Louisville, KY",        lat: 38.2527, lng: -85.7585 },
  { rank: 50, dma_code: "DMA-622", dma_name: "New Orleans, LA",       lat: 29.9511, lng: -90.0715 },
]

async function main() {
  console.log('Seeding accepted markets...')

  for (const dma of TOP_50_DMAS) {
    await prisma.acceptedMarket.upsert({
      where: { dma_code: dma.dma_code },
      update: {
        dma_name: dma.dma_name,
        lat: dma.lat,
        lng: dma.lng,
      },
      create: {
        dma_code: dma.dma_code,
        dma_name: dma.dma_name,
        lat: dma.lat,
        lng: dma.lng,
        base_concurrency: 1,
        is_active: true,
      },
    })
  }

  console.log(`Seeded ${TOP_50_DMAS.length} accepted markets.`)
  console.log('')
  console.log('Next steps:')
  console.log('  1. Set is_active=false for markets where you do NOT have driver pools')
  console.log('  2. Increase base_concurrency for markets where you run multiple trucks')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
