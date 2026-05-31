/* ============================================================
   RecruiterOS · Industry taxonomy
   A broad, searchable list of industries (250+) grouped by sector.
   Used by the Campaign Builder's signal search. window.ROS_INDUSTRIES
   is a flat [{name, sector}] list; window.ROS_SECTORS is the sector order.
   ============================================================ */
(function () {
  "use strict";
  const G = {
    "Technology & Software": [
      "Software Development", "SaaS", "Enterprise Software", "Vertical SaaS", "Cloud Computing",
      "Cloud Infrastructure", "Cybersecurity", "Artificial Intelligence", "Machine Learning",
      "Generative AI", "Data & Analytics", "Big Data", "Business Intelligence", "DevOps & Infrastructure",
      "Developer Tools", "Low-Code / No-Code", "API Platforms", "Computer Hardware", "Semiconductors",
      "Networking", "Information Technology & Services", "IT Consulting", "Computer & Network Security",
      "Mobile App Development", "Web Development", "Blockchain", "Cryptocurrency", "Web3",
      "Quantum Computing", "Robotics", "Computer Vision", "Natural Language Processing", "Embedded Systems",
      "Internet of Things (IoT)", "Edge Computing", "Databases", "Data Storage", "Productivity Software",
      "Collaboration Tools", "Project Management Software", "Customer Support Software", "CRM",
      "ERP", "Supply Chain Software", "MarTech", "SalesTech", "Open Source", "AR / VR", "Spatial Computing",
    ],
    "Financial Services": [
      "Financial Services", "Fintech", "Banking", "Investment Banking", "Venture Capital", "Private Equity",
      "Asset Management", "Wealth Management", "Insurance", "Insurtech", "Payments", "Lending", "Mortgage",
      "Accounting", "Capital Markets", "Hedge Funds", "Cryptocurrency Exchange", "Trading", "Brokerage",
      "Credit & Collections", "Financial Planning", "Tax Services", "Audit", "RegTech", "Neobanking",
      "Buy Now Pay Later", "Embedded Finance", "Real Estate Investment", "Pension & Retirement",
    ],
    "Healthcare & Life Sciences": [
      "Healthcare", "Hospitals & Health Systems", "Health Tech", "Digital Health", "Telemedicine",
      "Biotechnology", "Pharmaceuticals", "Medical Devices", "Mental Health", "Genomics",
      "Clinical Research", "Diagnostics", "Medical Practice", "Nursing & Residential Care", "Elder Care",
      "Veterinary", "Dental", "Health Insurance", "Life Sciences", "Drug Discovery", "Bioinformatics",
      "Wellness & Fitness", "Nutrition", "Femtech", "Medical Imaging", "Healthcare IT", "Pharmacy",
    ],
    "Commerce & Consumer": [
      "E-commerce", "Retail", "Consumer Goods", "Consumer Electronics", "Apparel & Fashion", "Luxury Goods",
      "Beauty & Cosmetics", "Food & Beverage", "Restaurants", "Grocery", "Consumer Packaged Goods (CPG)",
      "Direct-to-Consumer (D2C)", "Online Marketplaces", "Wholesale", "Furniture", "Home Goods",
      "Sporting Goods", "Toys & Games", "Jewelry & Watches", "Pet Care", "Subscription Commerce",
      "Resale & Secondhand", "Footwear", "Eyewear",
    ],
    "Industrial & Manufacturing": [
      "Manufacturing", "Industrial Automation", "Aerospace", "Defense", "Automotive", "Electric Vehicles",
      "Machinery", "Chemicals", "Plastics & Rubber", "Metals & Mining", "Building Materials",
      "Industrial Equipment", "Packaging", "Textiles", "Paper & Forest Products", "Shipbuilding",
      "Heavy Equipment", "Tooling", "Contract Manufacturing", "3D Printing & Additive", "Industrial IoT",
    ],
    "Energy & Environment": [
      "Energy", "Oil & Gas", "Renewable Energy", "Solar", "Wind", "Utilities", "Clean Tech", "Climate Tech",
      "Battery & Energy Storage", "Nuclear", "Power Generation", "Water & Wastewater",
      "Environmental Services", "Recycling & Waste Management", "Carbon Management", "Sustainability",
      "Hydrogen", "Geothermal", "EV Charging", "Grid Technology",
    ],
    "Transportation & Logistics": [
      "Logistics & Supply Chain", "Transportation", "Trucking", "Freight & Shipping", "Maritime",
      "Airlines & Aviation", "Rail", "Last-Mile Delivery", "Warehousing", "Fleet Management", "Mobility",
      "Ride-Sharing", "Autonomous Vehicles", "Drones & UAS", "Cold Chain", "Ports & Terminals", "Couriers",
    ],
    "Real Estate & Construction": [
      "Real Estate", "Commercial Real Estate", "PropTech", "Property Management", "Construction",
      "Architecture", "Civil Engineering", "Interior Design", "Facilities Management", "REITs",
      "Homebuilding", "Construction Tech", "Co-working", "Land Development", "Surveying",
    ],
    "Media & Entertainment": [
      "Media", "Entertainment", "Gaming", "Video Games", "Esports", "Music", "Film & Television",
      "Streaming", "Publishing", "News & Journalism", "Advertising", "Marketing", "Public Relations",
      "Social Media", "Content Creation", "Creator Economy", "Podcasting", "Animation", "Broadcasting",
      "Sports", "Sports Tech", "Live Events", "Digital Media", "Influencer Marketing",
    ],
    "Professional Services": [
      "Consulting", "Management Consulting", "Legal Services", "Law Firms", "LegalTech",
      "Staffing & Recruiting", "Human Resources", "HR Tech", "Accounting Services", "Market Research",
      "Design Services", "Marketing Agencies", "Business Services", "Outsourcing (BPO)",
      "Translation & Localization", "Customer Experience", "Procurement", "Executive Search",
    ],
    "Education": [
      "Education", "EdTech", "Higher Education", "K-12 Education", "E-Learning", "Online Education",
      "Tutoring", "Corporate Training", "Professional Development", "Research", "Vocational Training",
      "Early Childhood Education", "Language Learning", "Test Prep",
    ],
    "Government & Nonprofit": [
      "Government", "Public Sector", "GovTech", "Defense & Military", "Public Policy", "Nonprofit",
      "NGO", "Philanthropy", "Civic Tech", "International Affairs", "Think Tanks", "Social Services",
      "Public Safety", "Emergency Services",
    ],
    "Agriculture & Food": [
      "Agriculture", "AgTech", "Farming", "Food Production", "Food Tech", "Aquaculture", "Forestry",
      "Fishing", "Cannabis", "Alternative Protein", "Vertical Farming", "Crop Science", "Livestock",
    ],
    "Travel & Hospitality": [
      "Travel", "Hospitality", "Hotels", "Tourism", "Travel Tech", "Events", "Event Management",
      "Leisure", "Cruise Lines", "Vacation Rentals", "Theme Parks", "Casinos & Gaming",
    ],
    "Telecommunications": [
      "Telecommunications", "Wireless", "Internet Service Providers", "Satellite", "5G",
      "Network Infrastructure", "VoIP", "Fiber",
    ],
    "Emerging & Deep Tech": [
      "Space & Space Tech", "Defense Tech", "Synthetic Biology", "Nanotechnology", "Materials Science",
      "Longevity", "Wearables", "Hardware", "Deep Tech", "Neurotechnology", "Photonics", "Fusion Energy",
      "Gig Economy", "Dating & Social", "Productivity", "Community Platforms",
    ],
  };

  const SECTORS = Object.keys(G);
  const FLAT = [];
  for (const sector of SECTORS) {
    for (const name of G[sector]) FLAT.push({ name, sector });
  }

  window.ROS_SECTORS = SECTORS;
  window.ROS_INDUSTRIES = FLAT;          // [{ name, sector }]
  window.ROS_INDUSTRY_NAMES = FLAT.map((i) => i.name);
})();
