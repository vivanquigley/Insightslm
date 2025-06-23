import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { notebookId, filePath, sourceType } = await req.json()

    if (!notebookId || !sourceType) {
      return new Response(
        JSON.stringify({ error: 'notebookId and sourceType are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Processing request:', { notebookId, filePath, sourceType });

    // Get environment variables
    const webServiceUrl = Deno.env.get('NOTEBOOK_GENERATION_URL')
    const authHeader = Deno.env.get('NOTEBOOK_GENERATION_AUTH')

    if (!webServiceUrl || !authHeader) {
      console.error('Missing environment variables:', {
        hasUrl: !!webServiceUrl,
        hasAuth: !!authHeader,
        urlValue: webServiceUrl ? 'SET' : 'NOT_SET',
        authValue: authHeader ? 'SET' : 'NOT_SET'
      })
      
      return new Response(
        JSON.stringify({ 
          error: 'Web service configuration missing',
          details: {
            hasUrl: !!webServiceUrl,
            hasAuth: !!authHeader
          }
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Update notebook status to 'generating'
    await supabaseClient
      .from('notebooks')
      .update({ generation_status: 'generating' })
      .eq('id', notebookId)

    console.log('Calling external web service at:', webServiceUrl)

    // Prepare payload based on source type
    let payload: any = {
      sourceType: sourceType
    };

    if (filePath) {
      // For file sources (PDF, audio) or URLs (website, YouTube)
      payload.filePath = filePath;
    } else {
      // For text sources, we need to get the content from the database
      const { data: source, error: sourceError } = await supabaseClient
        .from('sources')
        .select('content')
        .eq('notebook_id', notebookId)
        .single();
      
      if (sourceError) {
        console.error('Error fetching source content:', sourceError);
        await supabaseClient
          .from('notebooks')
          .update({ generation_status: 'failed' })
          .eq('id', notebookId)
        
        return new Response(
          JSON.stringify({ error: 'Failed to fetch source content', details: sourceError }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      if (source?.content) {
        payload.content = source.content.substring(0, 5000); // Limit content size
      } else {
        console.error('No content found for text source');
        await supabaseClient
          .from('notebooks')
          .update({ generation_status: 'failed' })
          .eq('id', notebookId)
        
        return new Response(
          JSON.stringify({ error: 'No content found for text source' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    console.log('Sending payload to web service:', JSON.stringify(payload, null, 2));

    // Call external web service with timeout and better error handling
    let response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
      
      response = await fetch(webServiceUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
    } catch (fetchError) {
      console.error('Fetch error:', fetchError);
      
      // Update status to failed
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ 
          error: 'Failed to connect to web service',
          details: {
            message: fetchError.message,
            name: fetchError.name,
            url: webServiceUrl
          }
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Web service response status:', response.status);
    console.log('Web service response headers:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Web service error details:', {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: errorText,
        url: webServiceUrl
      });
      
      // Update status to failed
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ 
          error: 'Web service returned error',
          details: {
            status: response.status,
            statusText: response.statusText,
            body: errorText,
            url: webServiceUrl
          }
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let generatedData;
    try {
      const responseText = await response.text();
      console.log('Raw web service response:', responseText);
      generatedData = JSON.parse(responseText);
      console.log('Parsed generated data:', JSON.stringify(generatedData, null, 2));
    } catch (parseError) {
      console.error('Failed to parse web service response:', parseError);
      
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ 
          error: 'Invalid JSON response from web service',
          details: parseError.message
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse the response format: object with output property
    let title, description, notebookIcon, backgroundColor, exampleQuestions;
    
    if (generatedData && generatedData.output) {
      const output = generatedData.output;
      title = output.title;
      description = output.summary;
      notebookIcon = output.notebook_icon;
      backgroundColor = output.background_color;
      exampleQuestions = output.example_questions || [];
    } else {
      console.error('Unexpected response format:', {
        hasOutput: !!generatedData?.output,
        keys: generatedData ? Object.keys(generatedData) : 'null',
        fullResponse: generatedData
      });
      
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ 
          error: 'Invalid response format from web service',
          details: {
            expected: 'object with output property',
            received: generatedData ? Object.keys(generatedData) : 'null',
            fullResponse: generatedData
          }
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!title) {
      console.error('No title returned from web service:', {
        output: generatedData?.output,
        titleValue: title
      });
      
      await supabaseClient
        .from('notebooks')
        .update({ generation_status: 'failed' })
        .eq('id', notebookId)

      return new Response(
        JSON.stringify({ 
          error: 'No title in response from web service',
          details: {
            output: generatedData?.output,
            titleValue: title
          }
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Update notebook with generated content including icon, color, and example questions
    const { error: notebookError } = await supabaseClient
      .from('notebooks')
      .update({
        title: title,
        description: description || null,
        icon: notebookIcon || '📝',
        color: backgroundColor || 'gray',
        example_questions: exampleQuestions || [],
        generation_status: 'completed'
      })
      .eq('id', notebookId)

    if (notebookError) {
      console.error('Notebook update error:', notebookError)
      return new Response(
        JSON.stringify({ 
          error: 'Failed to update notebook',
          details: notebookError
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Successfully updated notebook with:', {
      title,
      description,
      icon: notebookIcon,
      color: backgroundColor,
      exampleQuestions
    });

    return new Response(
      JSON.stringify({ 
        success: true, 
        title, 
        description,
        icon: notebookIcon,
        color: backgroundColor,
        exampleQuestions,
        message: 'Notebook content generated successfully' 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Edge function error:', error)
    return new Response(
      JSON.stringify({ 
        error: 'Internal server error',
        details: {
          message: error.message,
          name: error.name,
          stack: error.stack
        }
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})