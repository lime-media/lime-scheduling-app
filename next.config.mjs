/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['mssql', 'tedious'],
  },
  webpack: (config) => {
    config.externals.push({
      'mssql':    'commonjs mssql',
      'tedious':  'commonjs tedious',
    })
    return config
  },
}

export default nextConfig
